// 轻量本地无声遥测模块：只读采集 Antigravity 本地 Language Server RPC 与活跃会话日志状态跃迁，不传输对话文本
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LS_SERVICE = '/exa.language_server_pb.LanguageServerService/';
const TAIL_WINDOW = 48 * 1024;

const TOOL_CATEGORY = new Map(Object.entries({
  read_file: 'reading', view_file: 'reading', view_file_outline: 'reading', view_code_item: 'reading', view_content_chunk: 'reading',
  list_dir: 'reading', list_directory: 'reading', find_by_name: 'reading', grep_search: 'reading', code_search: 'reading', find_all_references: 'reading',
  write_file: 'writing', write_to_file: 'writing', edit_file: 'writing', replace_file_content: 'writing', multi_replace_file_content: 'writing', edit_notebook: 'writing',
  run_command: 'running', command_status: 'running', send_command_input: 'running', read_terminal: 'running', execute_notebook: 'running',
  search_web: 'searching', read_url_content: 'searching', open_browser_url: 'searching', read_browser_page: 'searching', browser_subagent: 'searching', search_marketplace: 'searching',
  generate_image: 'drawing',
  invoke_subagent: 'delegating', define_subagent: 'delegating', manage_subagents: 'delegating', send_message: 'delegating',
  ask_question: 'asking', ask_permission: 'asking',
}));

const QUIET_TOOLS = new Set(['manage_task', 'schedule', 'list_permissions', 'task_boundary', 'notify_user', 'finish', 'wait', 'checkpoint']);

/** 将工具名称归类为语义动作类别，忽略高频调度噪音工具 */
export function toolCategory(name) {
  if (!name || QUIET_TOOLS.has(name)) return null;
  const known = TOOL_CATEGORY.get(name);
  if (known) return known;
  if (/image|draw|paint/.test(name)) return 'drawing';
  if (/subagent|delegate/.test(name)) return 'delegating';
  if (/browser|web|url|fetch/.test(name)) return 'searching';
  if (/write|edit|replace|patch|create/.test(name)) return 'writing';
  if (/read|view|list|grep|find|search|glob/.test(name)) return 'reading';
  return 'running';
}

function statusOf(raw) {
  return /RUNNING|BUSY|CANCELING/.test(raw || '') ? 'running' : 'idle';
}

function millis(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 解析 GetAllCascadeTrajectories 返回的会话摘要 */
export function parseConversations(response) {
  const conversations = new Map();
  for (const [id, value] of Object.entries(response?.trajectorySummaries || {})) {
    const metadata = value?.trajectoryMetadata || {};
    conversations.set(id, {
      id,
      status: statusOf(value?.status),
      steps: Number(value?.stepCount) || 0,
      modifiedAt: millis(value?.lastModifiedTime),
      userInputAt: millis(value?.lastUserInputTime),
      parentId: metadata.parentConversationId || null,
      termination: String(value?.latestExecutorTerminationReason || '').replace('EXECUTOR_TERMINATION_REASON_', ''),
      waiting: Array.isArray(value?.waitingSteps) && value.waitingSteps.length > 0,
    });
  }
  return conversations;
}

/** 对比两次会话快照，输出回合与子代理状态跃迁事件 */
export function diffConversations(previous, next, now = Date.now()) {
  const events = [];
  if (!previous) return events;
  for (const [id, current] of next) {
    const before = previous.get(id);
    const wasRunning = before?.status === 'running';
    const isRunning = current.status === 'running';
    if (current.parentId) {
      if (!wasRunning && isRunning) events.push({ type: 'subagent_start', id, parentId: current.parentId });
      if (wasRunning && !isRunning) events.push({ type: 'subagent_done', id, parentId: current.parentId, termination: current.termination });
      continue;
    }
    if (!wasRunning && isRunning) events.push({ type: 'turn_start', id, fresh: !before });
    if (wasRunning && !isRunning) {
      events.push({
        type: 'turn_end',
        id,
        termination: current.termination,
        steps: current.steps - (before?.steps || 0),
      });
    }
    if (before && current.userInputAt > before.userInputAt && now - current.userInputAt < 60000) {
      events.push({ type: 'user_input', id });
    }
  }
  return events;
}

/** 增量读取活跃会话的 transcript.jsonl 新增字节，仅提取工具与错误状态事件 */
export class TranscriptTail {
  constructor(file, since = Infinity) {
    this.file = file;
    this.since = since;
    this.offset = null;
    this.remainder = '';
    this.toolCount = 0;
    this.errors = 0;
  }

  async read() {
    let info;
    try {
      info = await stat(this.file);
    } catch {
      return [];
    }
    const first = this.offset === null;
    if (first) this.offset = Math.max(0, info.size - TAIL_WINDOW);
    if (info.size < this.offset) {
      this.offset = 0;
      this.remainder = '';
    }
    if (info.size === this.offset) return [];

    const startedMidFile = first && this.offset > 0;
    const length = Math.min(info.size - this.offset, 1 << 20);
    const handle = await open(this.file, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset += length;
      text = this.remainder + buffer.toString('utf8');
    } finally {
      await handle.close();
    }

    const lines = text.split('\n');
    this.remainder = lines.pop() || '';
    if (startedMidFile && lines.length) lines.shift();

    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      const stepAt = Date.parse(step.created_at || '') || 0;
      for (const event of this.ingest(step)) {
        if (!first || stepAt >= this.since) events.push(event);
      }
    }
    return events;
  }

  ingest(step) {
    const events = [];
    if (step.type === 'USER_INPUT') {
      this.toolCount = 0;
      this.errors = 0;
    } else if (step.type === 'CHECKPOINT') {
      events.push({ type: 'compact' });
    } else if (step.type === 'PLANNER_RESPONSE') {
      for (const call of step.tool_calls || []) {
        const category = toolCategory(call?.name);
        if (category) {
          this.toolCount++;
          events.push({ type: 'tool', category });
        }
      }
    }
    if (step.status === 'ERROR' || step.type === 'ERROR_MESSAGE') {
      this.errors++;
      events.push({ type: 'step_error' });
    }
    return events;
  }
}

function postJson(host, port, csrf, method, body, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        hostname: host,
        port,
        method: 'POST',
        path: LS_SERVICE + method,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const error = new Error(`${method} returned ${res.statusCode}`);
            error.status = res.statusCode;
            rejectPromise(error);
            return;
          }
          try {
            resolvePromise(text ? JSON.parse(text) : {});
          } catch {
            rejectPromise(new Error(`${method} returned malformed JSON`));
          }
        });
      }
    );
    req.on('error', rejectPromise);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} timed out`)));
    req.end(data);
  });
}

async function discoverLanguageServer() {
  const platform = process.platform;
  let rows = [];
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1 << 20,
    });
    rows = stdout.trim() ? [JSON.parse(stdout)].flat().map((r) => ({ pid: r.ProcessId, command: r.CommandLine || '' })) : [];
  } else {
    const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'pid=,args='], {
      timeout: 8000,
      maxBuffer: 1 << 22,
    });
    rows = stdout
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), command: m[2] }))
      .filter((r) => /language_server/.test(r.command));
  }
  const row = rows.find((r) => /--standalone\b/.test(r.command));
  if (!row) throw new Error('Antigravity language server is not running');
  const csrf = row.command.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!csrf) throw new Error('Language server exposes no CSRF token');

  const listing =
    platform === 'win32'
      ? (await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 22 })).stdout
      : (await execFileAsync('lsof', ['-nP', '-a', '-p', String(row.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 5000 })).stdout;

  const ports =
    platform === 'win32'
      ? [...listing.matchAll(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+\S+\s+(\d+)/g)]
          .filter((m) => Number(m[2]) === row.pid)
          .map((m) => Number(m[1]))
      : [...listing.matchAll(/:(\d+)\s*$/gm)].map((m) => Number(m[1]));

  for (const port of new Set(ports)) {
    try {
      await postJson('127.0.0.1', port, csrf, 'GetStatus', {}, 2500);
      return { host: '127.0.0.1', port, csrf };
    } catch {
      // 跳过 TLS/扩展端口
    }
  }
  throw new Error('Language server RPC port not found');
}

/** Antigravity 本地 Language Server 只读 RPC 客户端 */
export class LanguageServerClient {
  constructor({ env = process.env, discoverFn = discoverLanguageServer, transport = postJson } = {}) {
    this.transport = transport;
    this.discoverFn = discoverFn;
    this.endpoint = null;
    this.fromHost = false;
    const address = env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
    if (address && csrf) {
      const idx = address.lastIndexOf(':');
      this.endpoint = {
        host: idx > 0 ? address.slice(0, idx) : '127.0.0.1',
        port: Number(idx >= 0 ? address.slice(idx + 1) : address),
        csrf,
      };
      this.fromHost = Number.isInteger(this.endpoint.port) && this.endpoint.port > 0;
      if (!this.fromHost) this.endpoint = null;
    }
  }

  async call(method, body = {}, timeoutMs = 6000) {
    if (!this.endpoint) {
      this.endpoint = await this.discoverFn();
    }
    try {
      return await this.transport(this.endpoint.host, this.endpoint.port, this.endpoint.csrf, method, body, timeoutMs);
    } catch (error) {
      if (!this.fromHost && (error?.status === 401 || error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET')) {
        this.endpoint = null;
      }
      throw error;
    }
  }
}

export function resolveBrainDir(env = process.env) {
  const geminiDir = env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const appDataDir = resolve(geminiDir, env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
  return join(appDataDir, 'brain');
}

/** 面向立绘交互系统的轻量本地状态遥测器 */
export class LocalTelemetry {
  constructor({
    onSignal,
    log = () => {},
    env = process.env,
    brainDir = resolveBrainDir(env),
    ls = new LanguageServerClient({ env }),
    tailFactory = (file, since) => new TranscriptTail(file, since),
    now = Date.now,
  } = {}) {
    this.onSignal = onSignal;
    this.log = log;
    this.brainDir = brainDir;
    this.ls = ls;
    this.tailFactory = tailFactory;
    this.now = now;

    this.conversations = null;
    this.tails = new Map();
    this.starts = new Map();
    this.errorStreak = new Map();
    this.hadErrors = new Map();
    this.waitingSince = new Map();
    this.waitingNudged = new Set();

    this.lastCategory = null;
    this.lastCategoryAt = 0;
    this.lastStateSig = '';
    this.healthy = false;
    this._wasBusy = false;
    this._stopped = true;
    this._timer = null;
    this._polling = false;
    this._lastErrLogAt = 0;
  }

  _emit(sig) {
    try {
      this.onSignal?.(sig);
    } catch {
      // 忽略信号分发异常，保持采集稳定
    }
  }

  _tailFor(id, since) {
    let tail = this.tails.get(id);
    if (!tail) {
      tail = this.tailFactory(join(this.brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), since);
      this.tails.set(id, tail);
    }
    return tail;
  }

  _handleTailEvent(id, isSubagent, ev, now) {
    if (ev.type === 'compact') {
      this.lastCategory = 'compacting';
      this.lastCategoryAt = now;
      this._emit({ type: 'compact' });
      return;
    }
    if (ev.type === 'step_error') {
      const nextStreak = (this.errorStreak.get(id) || 0) + 1;
      this.errorStreak.set(id, nextStreak);
      this.hadErrors.set(id, true);
      this._emit({ type: 'step_error', streak: nextStreak });
      return;
    }
    if (ev.type === 'tool') {
      if (!isSubagent || !this.lastCategory) {
        this.lastCategory = ev.category;
        this.lastCategoryAt = now;
      }
      if (!isSubagent && (this.errorStreak.get(id) || 0) > 0) {
        this.errorStreak.set(id, 0);
        this._emit({ type: 'error_fixed' });
      }
    }
  }

  async pollOnce() {
    const firstPoll = !this.conversations;
    const excludeSubtrajectories = !firstPoll && !this._wasBusy;
    const response = await this.ls.call('GetAllCascadeTrajectories', { excludeSubtrajectories });
    const next = parseConversations(response);
    const now = this.now();
    const events = diffConversations(this.conversations, next, now);
    this.conversations = next;

    for (const ev of events) {
      if (ev.type === 'turn_start') {
        this.starts.set(ev.id, now);
        this.errorStreak.set(ev.id, 0);
        this.hadErrors.set(ev.id, false);
      } else if (ev.type === 'user_input') {
        this._emit({ type: 'user_sent' });
      } else if (ev.type === 'turn_end') {
        const tail = this.tails.get(ev.id);
        let lateFixed = false;
        if (tail) {
          for (const late of await tail.read()) {
            const prevStreak = this.errorStreak.get(ev.id) || 0;
            this._handleTailEvent(ev.id, false, late, now);
            if (late.type === 'tool' && prevStreak > 0) lateFixed = true;
          }
        }
        const started = this.starts.get(ev.id);
        const durationMs = started ? Math.max(0, now - started) : 0;
        const hadErrors = !!this.hadErrors.get(ev.id);
        const toolCount = tail?.toolCount || 0;
        if (hadErrors && !lateFixed && (this.errorStreak.get(ev.id) || 0) > 0 && !/ERROR|CANCEL|FAIL/i.test(ev.termination || '')) {
          this.errorStreak.set(ev.id, 0);
          this._emit({ type: 'error_fixed' });
        }
        this.starts.delete(ev.id);
        this.errorStreak.delete(ev.id);
        this.hadErrors.delete(ev.id);
        this.tails.delete(ev.id);
        this._emit({ type: 'turn_done', durationMs, hadErrors, toolCount });
      }
    }

    const running = [...next.values()].filter((c) => c.status === 'running');
    if (firstPoll) {
      for (const c of running) {
        if (!c.parentId) this.starts.set(c.id, now);
      }
    }
    const since = firstPoll ? Infinity : now - 15000;
    for (const conv of running) {
      const tail = this._tailFor(conv.id, since);
      for (const ev of await tail.read()) {
        this._handleTailEvent(conv.id, !!conv.parentId, ev, now);
      }
    }

    for (const id of this.tails.keys()) {
      if (next.get(id)?.status !== 'running' && !events.some((e) => e.id === id)) {
        this.tails.delete(id);
      }
    }

    // 检查等你确认/回答状态（>= 8 秒未响应触发无声歪头提醒）
    for (const [id, conv] of next) {
      if (conv.status === 'running' && conv.waiting) {
        if (!this.waitingSince.has(id)) {
          this.waitingSince.set(id, now);
        } else if (now - this.waitingSince.get(id) >= 8000 && !this.waitingNudged.has(id)) {
          this.waitingNudged.add(id);
          this._emit({ type: 'waiting_nudge' });
        }
      } else {
        this.waitingSince.delete(id);
        this.waitingNudged.delete(id);
      }
    }
    for (const id of [...this.waitingSince.keys()]) {
      if (!next.has(id)) {
        this.waitingSince.delete(id);
        this.waitingNudged.delete(id);
      }
    }

    const roots = running.filter((c) => !c.parentId);
    const subagents = running.filter((c) => !!c.parentId);
    const busy = roots.length > 0 || subagents.length > 0;
    this._wasBusy = busy;
    if (!busy) this.lastCategory = null;
    const staleTool = !this.lastCategory || now - this.lastCategoryAt > 12000;
    const anyWaiting = running.some((c) => c.waiting);
    let phase = 'idle';
    if (busy) {
      if (subagents.length >= 2) phase = 'subagents';
      else if (anyWaiting) phase = 'waiting';
      else if (!staleTool) phase = 'tool';
      else phase = 'thinking';
    }
    const activeTool = busy && !staleTool ? this.lastCategory : null;
    const sig = `${busy ? 1 : 0}|${phase}|${subagents.length}|${activeTool || ''}`;
    if (sig !== this.lastStateSig) {
      this.lastStateSig = sig;
      this._emit({
        type: 'ai_state',
        busy,
        phase,
        subagents: subagents.length,
        toolCategory: activeTool,
      });
    }

    this.healthy = true;
    return { busy, running: roots.length, subagents: subagents.length, phase };
  }

  _scheduleNext(delayMs) {
    if (this._stopped) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => void this._tick(), delayMs);
    this._timer.unref?.();
  }

  async _tick() {
    if (this._stopped || this._polling) return;
    this._polling = true;
    let nextDelay = 2500;
    try {
      const info = await this.pollOnce();
      nextDelay = info.busy ? 1500 : 2500;
    } catch (err) {
      this.healthy = false;
      nextDelay = 5000;
      const t = this.now();
      if (t - this._lastErrLogAt > 60000) {
        this._lastErrLogAt = t;
        this.log(`telemetry standby: ${err?.message || 'unavailable'}`);
      }
    } finally {
      this._polling = false;
      this._scheduleNext(nextDelay);
    }
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._scheduleNext(400);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
  }
}
