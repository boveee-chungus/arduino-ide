import Firmata from 'firmata';
import five from 'johnny-five';
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import process from 'process';

// Force Buffer to be globally available for Johnny-Five's internal dependencies
window.Buffer = Buffer;

// ---------------------------------------------------------------------------
// Node `process` compat shim for the browser polyfill.
//
// johnny-five calls process.hrtime() inside its internal board "ready"
// handler. The browser polyfill (process/browser.js) implements nextTick and
// a no-op .on(), but NOT hrtime — and one missing method throwing inside the
// Firmata parse pipeline aborts the "ready" broadcast and kills the serial
// reader. Complete the polyfill before any board code runs.
// ---------------------------------------------------------------------------
globalThis.process = globalThis.process || process;
const proc = process;
if (!proc.env) proc.env = {};
if (!proc.nextTick) proc.nextTick = (fn, ...args) => setTimeout(() => fn(...args), 0);
if (!proc.hrtime) {
  const hrOrigin = performance.now();
  proc.hrtime = function hrtime(previous) {
    const ms = performance.now() - hrOrigin;
    const seconds = Math.floor(ms / 1000);
    let nanos = Math.round((ms / 1000 - seconds) * 1e9);
    if (nanos > 999999999) nanos = 999999999;
    if (!previous) return [seconds, nanos];
    let dSec = seconds - previous[0];
    let dNano = nanos - previous[1];
    if (dNano < 0) { dSec -= 1; dNano += 1e9; }
    return [dSec, dNano];
  };
  proc.hrtime.bigint = () => BigInt(Math.round((performance.now() - hrOrigin) * 1e6));
}
if (!proc.once) proc.once = () => {};
if (!proc.removeListener) proc.removeListener = () => {};
if (!proc.removeAllListeners) proc.removeAllListeners = () => {};
if (!proc.exit) proc.exit = () => {};
if (!proc.reallyExit) proc.reallyExit = () => {};
if (!proc.versions) proc.versions = {};

// ---------------------------------------------------------------------------
// Diagnostics: add "?debug" to the URL to log every raw serial byte as hex.
// ---------------------------------------------------------------------------
const DEBUG = new URLSearchParams(window.location.search).has('debug');
function log(...args) {
  console.log('%c[ide]%c', 'color:#0e639c;font-weight:bold', '', ...args);
}
function logBytes(label, bytes) {
  if (!DEBUG) return;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`[ide] ${label} (${bytes.length} bytes): ${hex}`);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The Uno's optiboot bootloader listens for ~1s after reset before starting
// StandardFirmata, so we have to wait it out before the handshake can begin.
const RESET_LOW_MS = 250;    // DTR/RTS held low before asserting the reset pulse
const BOOT_SETTLE_MS = 2000; // bootloader timeout + sketch boot time

// ---------------------------------------------------------------------------
// 1. The Hardware Bridge
//
// IMPORTANT: the transport must emit "open" only AFTER `new Firmata(...)`
// and `new five.Board(...)` have been constructed on top of it.
//
//   - firmata-io attaches its transport.on("open") listener in its own
//     constructor and relays it as "open"/"connect". An "open" event fired
//     before that constructor runs is missed FOREVER.
//   - johnny-five will not broadcast board.on("ready") unless it has seen
//     the io "connect" event first (board.js postpones "ready" forever).
//
// Missing that relay is the root cause of the "Connecting..." hang.
// ---------------------------------------------------------------------------
class WebSerialTransport extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.writer = null;
    this.opened = false;
  }

  async open() {
    if (this.opened) return;

    await this.port.open({ baudRate: 57600, flowControl: 'none' });

    // Attach the reader IMMEDIATELY. As soon as the board finishes booting,
    // StandardFirmata broadcasts its REPORT_VERSION packet; if nobody is
    // reading at that moment the bytes are dropped and the handshake stalls.
    this.readLoop();

    // Manually pulse DTR/RTS to reboot the Uno into a clean, known-good
    // state (the browser does not auto-assert these lines like desktop IDEs).
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      await sleep(RESET_LOW_MS);
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
      log('DTR/RTS pulse sent — board is resetting');
    } catch (err) {
      // Some clone USB-serial chips don't implement setSignals. The sketch
      // is already running, so the explicit version request below will
      // still be answered without a reset.
      log('DTR/RTS reset unsupported on this adapter, continuing:', err.message);
    }

    // Let the bootloader time out and StandardFirmata start running.
    await sleep(BOOT_SETTLE_MS);

    this.writer = this.port.writable.getWriter();
    this.opened = true;
    log('Serial port open — emitting "open" to Firmata');
    this.emit('open');
  }

  // firmata-io calls transport.write(buffer, callback) for EVERY command and
  // decrements its flow-control counter (board.pending) in that callback.
  // The callback MUST be invoked or the counter drifts forever.
  write(data, callback) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    logBytes('TX', bytes);
    if (!this.opened || !this.writer) {
      if (callback) callback(new Error('Serial port is not open'));
      return;
    }
    this.writer.write(bytes).then(
      () => { if (callback) callback(); },
      (err) => {
        console.error('[ide] Serial write failed:', err);
        if (callback) callback(err);
      }
    );
  }

  async readLoop() {
    const reader = this.port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          reader.releaseLock();
          break;
        }
        if (value) {
          logBytes('RX', value);
          try {
            this.emit('data', Buffer.from(value));
          } catch (error) {
            // A bug in a data listener must never kill the reader loop.
            console.error('[ide] Error while processing serial data:', error);
          }
        }
      }
    } catch (error) {
      log('Serial reader stopped:', error.message);
      this.emit('close');
    }
  }

  async close() {
    this.opened = false;
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

// 2. Initialize the Monaco Code Editor
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
  window.editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: [
      '// Write Johnny-Five JavaScript here.',
      '// The "board" and "five" variables are already provided.',
      '',
      'const led = new five.Led(13);',
      'led.blink(200);'
    ].join('\n'),
    language: 'javascript',
    theme: 'vs-dark'
  });
});

// 3. UI Connection and Execution Logic
let activeBoard = null;
let activePort = null;

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const runBtn = document.getElementById('runBtn');

function setStatus(text) {
  statusEl.innerText = 'Status: ' + text;
}

function resetConnectionUI(message) {
  activeBoard = null;
  activePort = null;
  setStatus(message);
  runBtn.disabled = true;
  connectBtn.disabled = false;
  connectBtn.innerText = '1. Connect Arduino';
}

// Surface unexpected USB unplug so the UI never stays stuck on "Connected".
navigator.serial.addEventListener('disconnect', (event) => {
  if (event.target !== activePort) return;
  log('USB device unplugged');
  resetConnectionUI('USB unplugged — reconnect');
});

connectBtn.addEventListener('click', async () => {
  try {
    const port = await navigator.serial.requestPort();
    activePort = port;
    connectBtn.disabled = true;
    connectBtn.innerText = 'Connecting...';
    setStatus('Opening serial port...');

    const transport = new WebSerialTransport(port);

    // 1. Firmata FIRST: its constructor registers the transport "open"
    //    listener and relays it as "connect" for Johnny-Five.
    const io = new Firmata(transport);

    // 2. Johnny-Five SECOND: it attaches "connect"/"ready" listeners to the
    //    io object and requires "connect" to precede "ready".
    activeBoard = new five.Board({ io, repl: false });

    activeBoard.on('connect', () => {
      log('johnny-five: connected — Firmata handshake in progress');
      setStatus('Connecting (handshake with Firmata)...');
    });

    activeBoard.on('error', (err) => {
      console.error('[ide] johnny-five error:', err);
      resetConnectionUI('Board error (see console)');
    });

    activeBoard.on('ready', () => {
      log('johnny-five: board READY');
      setStatus('Connected & Ready');
      runBtn.disabled = false;
      connectBtn.innerText = 'Connected to USB';
    });

    // 3. Only NOW open the port, pulse DTR/RTS and emit "open".
    setStatus('Connecting (board reset takes ~2s)...');
    await transport.open();

    // 4. Ask for the Firmata version right away instead of waiting for
    //    firmata-io's 5 second failsafe. Harmless if the board already
    //    broadcast it on boot — the parser handles duplicates fine.
    io.reportVersion(() => {});

  } catch (err) {
    console.error('[ide] Connection failed:', err);
    resetConnectionUI('Connection Failed: ' + err.message);
  }
});

runBtn.addEventListener('click', () => {
  if (!activeBoard) return;

  const studentCode = window.editor.getValue();
  try {
    const executeStudentCode = new Function('five', 'board', studentCode);
    executeStudentCode(five, activeBoard);
  } catch (e) {
    alert("Error in your code: " + e.message);
  }
});