// 发布前自检脚本：验证注入函数序列化、Overscan WebGL 控制器、16 套立绘、10 款表情及本地遥测状态机无异常
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_EXPRESSIONS, BUILTIN_PORTRAITS, BUILTIN_PRESETS, DEFAULT_SETTINGS } from './presets.mjs';
import { normalizeSettings, resolveEffectiveTheme } from './settings.mjs';
import { CompatWebSocket, ThemeInjector, pageController, parseCdpArgs, profileDirectories } from './cdp-injector.mjs';
import { LocalTelemetry, TranscriptTail, diffConversations, parseConversations } from './telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '..', '..', 'assets');

// 1. 验证真实序列化的页面控制器可无误解析编译，且包含 v3 扩边/分体表情/光影/遥测关键符号
const ctrlSrc = pageController.toString();
const compiled = new Function(`return (${ctrlSrc})`);
if (typeof compiled() !== 'function') throw new Error('pageController serialization failed');
for (const marker of ['shaderVer = 5', '__atsOnSignal', 'u_expr_eye', 'u_outfit_wipe', 'u_rim_fill', '/ 1.16', 'wakeup']) {
  if (marker === 'wakeup' && !ctrlSrc.includes('wakeFromAfk')) {
    throw new Error('Missing AFK wake handler in pageController');
  } else if (marker !== 'wakeup' && !ctrlSrc.includes(marker)) {
    throw new Error(`Missing v3 marker in pageController: ${marker}`);
  }
}

// 2. 验证 16 套内置立绘、10 款表情与新增动态设置项规范化
const inj = new ThemeInjector({
  assetsDir: ASSETS,
  getSettings: () => DEFAULT_SETTINGS,
  resolveTheme: (s, o) => resolveEffectiveTheme(s, o),
});

const portraitIds = Object.keys(BUILTIN_PORTRAITS);
if (portraitIds.length !== 16) throw new Error(`Expected 16 builtin portraits, got ${portraitIds.length}`);
for (const outfitId of portraitIds) {
  const file = join(ASSETS, BUILTIN_PORTRAITS[outfitId].file);
  if (!existsSync(file)) throw new Error(`Missing portrait asset: ${file}`);
  const s = normalizeSettings({ portrait: { dayOutfit: outfitId, nightOutfit: outfitId } });
  for (const phase of ['day', 'night']) {
    const asset = inj._resolveImageAsset({ portraitKey: phase }, s);
    if (!asset.showPortrait || !asset.hash || !asset.dataUrl?.startsWith('data:image/')) {
      throw new Error(`Invalid resolved asset for ${phase}/${outfitId}`);
    }
    if (asset.outfitKey !== outfitId) {
      throw new Error(`Expected outfitKey=${outfitId}, got ${asset.outfitKey}`);
    }
    if (!asset.allowExpression || !asset.exprAnchor || typeof asset.exprAnchor.dx !== 'number') {
      throw new Error(`Expected builtin outfit ${outfitId} to allow expressions with valid exprAnchor`);
    }
  }
}

const exprIds = Object.keys(BUILTIN_EXPRESSIONS);
if (exprIds.length !== 10) throw new Error(`Expected 10 expressions, got ${exprIds.length}`);
const exprPack = inj._resolveExpressionPack();
if (!exprPack.hash) throw new Error('Missing expression pack hash');
for (const exprId of exprIds) {
  const expr = BUILTIN_EXPRESSIONS[exprId];
  if (expr.file) {
    const file = join(ASSETS, expr.file);
    if (!existsSync(file)) throw new Error(`Missing expression asset: ${file}`);
    if (!exprPack.patches?.[exprId]?.dataUrl?.startsWith('data:image/png;base64,')) {
      throw new Error(`Invalid resolved expression patch for ${exprId}`);
    }
  }
  const s = normalizeSettings({ portrait: { expression: exprId } });
  if (s.portrait.expression !== exprId) throw new Error(`normalizeSettings rejected expression ${exprId}`);
}
if (normalizeSettings({ portrait: { expression: 'nonexistent' } }).portrait.expression !== 'default') {
  throw new Error('normalizeSettings did not fallback invalid expression to default');
}

const sFlags = normalizeSettings({ portrait: { microMotion: false, ambientLight: false, aiCompanion: false } });
if (sFlags.portrait.microMotion !== false || sFlags.portrait.ambientLight !== false || sFlags.portrait.aiCompanion !== false) {
  throw new Error('normalizeSettings failed on microMotion/ambientLight/aiCompanion false flags');
}

// 3. 验证 randomLook 事件路由与 _broadcastSignal 安全执行
const patches = [];
const mockInj = new ThemeInjector({
  assetsDir: ASSETS,
  getSettings: () => DEFAULT_SETTINGS,
  resolveTheme: (s, o) => resolveEffectiveTheme(s, o),
  onPatch: (p) => patches.push(p),
});
mockInj._handleSessionEvent({ knownImageHashes: new Set() }, {
  method: 'Runtime.bindingCalled',
  params: { name: '__atsBridge', payload: JSON.stringify({ action: 'randomLook' }) },
});
if (!(patches[0]?.portrait?.dayOutfit || patches[0]?.portrait?.nightOutfit) || !patches[0]?.portrait?.expression) {
  throw new Error('randomLook did not produce portrait patch');
}
await mockInj._broadcastSignal({ type: 'turn_done', durationMs: 9000, hadErrors: false, toolCount: 2 });

// 4. 验证全部内置预设解析正常
for (const presetId of Object.keys(BUILTIN_PRESETS)) {
  const s = normalizeSettings({ mode: 'manual-preset', manualPresetId: presetId });
  const eff = resolveEffectiveTheme(s);
  if (!eff?.palette?.bgPage) throw new Error(`Invalid effective theme for ${presetId}`);
}

// 5. Telemetry 单元测试（parseConversations / diffConversations / TranscriptTail / LocalTelemetry 状态机）
const snap1 = parseConversations({
  trajectorySummaries: {
    c1: { status: 'TASK_STATUS_RUNNING', stepCount: 1, lastModifiedTime: '2026-11-21T00:00:01Z', waitingSteps: [] },
    s1: { status: 'TASK_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: 'c1' } },
    s2: { status: 'TASK_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: 'c1' } },
  },
});
const snap2 = parseConversations({
  trajectorySummaries: {
    c1: { status: 'TASK_STATUS_IDLE', stepCount: 4, lastModifiedTime: '2026-11-21T00:00:12Z', waitingSteps: [] },
    s1: { status: 'TASK_STATUS_IDLE', trajectoryMetadata: { parentConversationId: 'c1' } },
    s2: { status: 'TASK_STATUS_IDLE', trajectoryMetadata: { parentConversationId: 'c1' } },
  },
});
const diffs = diffConversations(snap1, snap2, 20000);
if (!diffs.some((d) => d.type === 'turn_end' && d.id === 'c1') || diffs.filter((d) => d.type === 'subagent_done').length !== 2) {
  throw new Error(`Unexpected diffConversations result: ${JSON.stringify(diffs)}`);
}

const tail = new TranscriptTail('unused.jsonl');
const eCompact = tail.ingest({ type: 'CHECKPOINT' });
const eErr = tail.ingest({ type: 'PLANNER_RESPONSE', status: 'ERROR', tool_calls: [{ name: 'run_command' }] });
if (eCompact[0]?.type !== 'compact' || !eErr.some((e) => e.type === 'step_error') || !eErr.some((e) => e.type === 'tool' && e.category === 'running')) {
  throw new Error('TranscriptTail.ingest failed to classify compact/tool/step_error');
}

let clock = 1000;
const signals = [];
let pollStep = 0;
const mockTailEvents = [
  [{ type: 'compact' }, { type: 'step_error' }],
  [{ type: 'tool', category: 'writing' }],
];
const fakeLs = {
  async call() {
    pollStep++;
    if (pollStep === 1) {
      return {
        trajectorySummaries: {
          r1: { status: 'TASK_STATUS_RUNNING', waitingSteps: [{}] },
          sub1: { status: 'TASK_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: 'r1' } },
          sub2: { status: 'TASK_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: 'r1' } },
        },
      };
    }
    if (pollStep === 2) {
      return {
        trajectorySummaries: {
          r1: { status: 'TASK_STATUS_RUNNING', waitingSteps: [{}] },
        },
      };
    }
    return {
      trajectorySummaries: {
        r1: { status: 'TASK_STATUS_IDLE', latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_STOP' },
      },
    };
  },
};
const tel = new LocalTelemetry({
  ls: fakeLs,
  now: () => clock,
  onSignal: (s) => signals.push(s),
  tailFactory: () => ({ toolCount: 3, read: async () => mockTailEvents.shift() || [] }),
});
await tel.pollOnce();
clock += 9000;
await tel.pollOnce();
clock += 1000;
await tel.pollOnce();
const sigTypes = signals.map((s) => s.type);
for (const expected of ['ai_state', 'compact', 'step_error', 'waiting_nudge', 'error_fixed', 'turn_done']) {
  if (!sigTypes.includes(expected)) {
    throw new Error(`LocalTelemetry missed signal ${expected}, got: ${JSON.stringify(signals)}`);
  }
}
const subSig = signals.find((s) => s.type === 'ai_state' && s.phase === 'subagents');
if (!subSig || subSig.subagents !== 2) {
  throw new Error(`Expected subagents phase signal, got: ${JSON.stringify(signals)}`);
}

inj.telemetry?.stop?.();
mockInj.telemetry?.stop?.();
tel.stop();

// 6. 验证跨平台 CDP 参数解析与 Node 18/20 无原生 WebSocket 时的 CompatWebSocket 回退
const parsedArgs = parseCdpArgs('Antigravity.exe --user-data-dir="C:\\Custom\\Antigravity Data" --remote-debugging-port=9229 --remote-debugging-port=0');
if (parsedArgs.ports[0] !== 9229 || parsedArgs.userDataDirs[0] !== 'C:\\Custom\\Antigravity Data') {
  throw new Error(`parseCdpArgs failed: ${JSON.stringify(parsedArgs)}`);
}
const dirs = profileDirectories({ env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', ANTIGRAVITY_USER_DATA_DIR: 'D:\\AgyData' }, platform: 'win32' });
if (dirs[0] !== 'D:\\AgyData' || dirs.length < 3) {
  throw new Error(`profileDirectories failed: ${JSON.stringify(dirs)}`);
}

await new Promise((resolveTest, rejectTest) => {
  const srv = createServer();
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const need = off + 4 + len;
        if (buf.length < need) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, need));
        buf = buf.subarray(need);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        const hdr = payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
        socket.write(Buffer.concat([hdr, payload]));
      }
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address();
    const ws = new CompatWebSocket(`ws://127.0.0.1:${addr.port}/devtools/browser/test`);
    const bigMsg = 'x'.repeat(240);
    const got = [];
    ws.addEventListener('open', () => {
      ws.send('ping-1');
      ws.send(bigMsg);
    });
    ws.addEventListener('message', (ev) => {
      got.push(ev.data);
      if (got.length === 2) {
        if (got[0] !== 'ping-1' || got[1] !== bigMsg) {
          ws.close();
          srv.close(() => rejectTest(new Error('CompatWebSocket echo mismatch')));
          return;
        }
        ws.close();
        srv.close(() => resolveTest());
      }
    });
    ws.addEventListener('error', (err) => {
      srv.close(() => rejectTest(err?.error || new Error('CompatWebSocket error')));
    });
  });
});

console.log('self-check OK:', {
  presets: Object.keys(BUILTIN_PRESETS).length,
  portraits: portraitIds.length,
  expressions: exprIds.length,
  telemetrySignalsTested: [...new Set(sigTypes)].length,
  controllerBytes: ctrlSrc.length,
});
