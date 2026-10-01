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
// Monaco 0.39.0 is self-hosted under /vs/ — the official AMD layout. Do NOT
// add a paths mapping like {'vs': 'monaco'}: the editor worker's internal
// loader resolves 'vs/...' from the site root and cannot see page config.
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
const stopBtn = document.getElementById('stopBtn');

function setStatus(text) {
  statusEl.innerText = 'Status: ' + text;
}

function resetConnectionUI(message) {
  // The port is dying/dead — drop the board reference first so the cleanup
  // below skips the SYSTEM_RESET write into a closed serial connection.
  activeBoard = null;
  activePort = null;
  // Stop leftover blink/sweep timers so nothing keeps writing into the
  // closed port (and the next connection starts from a clean slate).
  stopPreviousRun();
  setStatus(message);
  runBtn.disabled = true;
  stopBtn.disabled = true;
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
      stopBtn.disabled = false;
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

// ---------------------------------------------------------------------------
// 4. Run Isolation — every "Run" (and "Stop") starts from a clean slate.
//
// Clicking Run executes the editor's CURRENT code, but johnny-five objects
// keep running after that function returns: led.blink() registers a raw
// setInterval that toggles its pin forever (lib/led/led.js), servo.sweep()
// does the same, and board.wait() chains park timeouts. Without cleanup, a
// second run STACKS a second blink timer on the same pin — two out-of-phase
// timers flicker the LED erratically, and reverting the code to an earlier
// value cannot undo timers that are already scheduled.
//
// Three-part cleanup before each new run (and on Stop):
//   a. stop + release every johnny-five object the previous run created,
//   b. clear every timer the previous run scheduled (whichever library),
//   c. Firmata SYSTEM_RESET so the board's pins return to power-on defaults.
// ---------------------------------------------------------------------------
const runTimers = new Set();     // timer ids created since the first Run
const runComponents = new Set(); // five.* objects created by student code
let runActive = false;           // flips on at the first Run and stays on

const nativeSetTimeout = window.setTimeout;
const nativeSetInterval = window.setInterval;
const nativeClearTimeout = window.clearTimeout;
const nativeClearInterval = window.clearInterval;

window.setTimeout = function (...args) {
  const id = nativeSetTimeout.apply(window, args);
  if (runActive) runTimers.add(id);
  return id;
};
window.setInterval = function (...args) {
  const id = nativeSetInterval.apply(window, args);
  if (runActive) runTimers.add(id);
  return id;
};

// Browser timer ids share one namespace, so both clears are tried; clearing
// an already-cleared id is a no-op.
function clearRunTimers() {
  for (const id of runTimers) {
    nativeClearTimeout.call(window, id);
    nativeClearInterval.call(window, id);
  }
  runTimers.clear();
}

// Students receive this wrapped `five`: identical API, but every constructed
// component registers itself so the next run (or Stop) can shut it down.
// Wrappers are cached so repeated `five.Led` lookups stay identity-stable.
const wrappedCtors = new WeakMap();
const runFive = new Proxy(five, {
  get(target, prop) {
    const value = Reflect.get(target, prop);
    if (typeof value !== 'function') return value;
    let ctor = wrappedCtors.get(value);
    if (!ctor) {
      ctor = new Proxy(value, {
        construct(Real, args) {
          const instance = new Real(...args);
          runComponents.add(instance);
          return instance;
        }
      });
      wrappedCtors.set(value, ctor);
    }
    return ctor;
  }
});

function stopPreviousRun() {
  // a. Ask each leftover component to stop its own behaviour first.
  for (const instance of runComponents) {
    for (const method of ['stop', 'stopServo', 'off']) {
      try {
        if (typeof instance[method] === 'function') instance[method]();
      } catch (err) {
        log('cleanup: ' + method + '() failed on a leftover component:', err.message);
      }
    }
  }
  runComponents.clear();

  // b. Belt and braces: kill every scheduled timer from previous runs, even
  //    those owned by objects that had no stop() method. (Editor timers
  //    created after the first Run are cleared too — Monaco recreates any it
  //    still needs on the next interaction.)
  clearRunTimers();

  // c. Firmata SYSTEM_RESET (0xFF): StandardFirmata re-initialises every pin
  //    to its power-on state, clearing PWM/SERVO modes and latched HIGH/LOW
  //    values left behind by the previous run. The parser already tolerates
  //    the duplicate version/capability reports the board sends in response.
  if (activeBoard && activeBoard.io && typeof activeBoard.io.reset === 'function') {
    try {
      activeBoard.io.reset();
      log('Firmata SYSTEM_RESET sent — board pins back to power-on defaults');
    } catch (err) {
      log('Firmata SYSTEM_RESET failed:', err.message);
    }
  }
}

runBtn.addEventListener('click', () => {
  if (!activeBoard) return;

  // Clean slate: shut down leftovers from any previous run BEFORE the
  // editor's current code executes.
  stopPreviousRun();
  runActive = true; // from the first Run on, track every new timer

  const studentCode = window.editor.getValue();
  try {
    const executeStudentCode = new Function('five', 'board', studentCode);
    executeStudentCode(runFive, activeBoard);
  } catch (e) {
    alert("Error in your code: " + e.message);
  }
});

stopBtn.addEventListener('click', () => {
  if (!activeBoard) return;
  stopPreviousRun();
  setStatus('Stopped — board ready for new code');
});

// ---------------------------------------------------------------------------
// 5. Sample library — the toolbar dropdown inserts starter code at the cursor.
//
// Every sample below is verified to work with StandardFirmata on an Uno R3
// and the pins noted in its header comment. PWM is only available on pins
// 3, 5, 6, 9, 10 and 11 on the Uno.
// ---------------------------------------------------------------------------
const SAMPLES = {
  blink: `// Blink the onboard LED (pin 13).
const led = new five.Led(13);
led.blink(200);`,

  strobe: `// Strobe two LEDs at different speeds.
// Wiring: LEDs (with ~220 ohm resistors) on pins 13 and 12.
const ledA = new five.Led(13);
const ledB = new five.Led(12);
ledA.strobe(300);
ledB.strobe(500);
// Press "3. Stop" to halt both.`,

  fade: `// Fade an LED in and out forever.
// NOTE: fading needs a PWM pin — 3, 5, 6, 9, 10 or 11.
// (Pin 13 has no PWM on the Uno.)
const led = new five.Led(9);
led.fadeIn();

board.wait(2000, () => {
  led.fadeOut();
  board.wait(2000, () => led.fadeIn());
});`,

  brightness: `// Set LED brightness directly: 0 (off) to 255 (full).
// PWM pin required: 3, 5, 6, 9, 10 or 11.
const led = new five.Led(9);
led.brightness(128);`,

  buttonToggle: `// Each button press toggles the onboard LED.
// Wiring: pushbutton between pin 2 and GND (internal pull-up is used).
const led = new five.Led(13);
const button = new five.Button(2);

let isOn = false;
button.on('press', () => {
  isOn = !isOn;
  if (isOn) {
    led.on();
  } else {
    led.off();
  }
});`,

  buttonLog: `// Log button press/release events.
// Wiring: pushbutton between pin 2 and GND.
const button = new five.Button(2);

button.on('press', () => console.log('Button pressed'));
button.on('release', () => console.log('Button released'));
// Output appears in the browser console (F12 -> Console).`,

  analogLog: `// Read an analog sensor on A0 (photoresistor, potentiometer, etc.).
// Wiring: sensor voltage divider between 5V and GND, midpoint to A0.
const sensor = new five.Sensor('A0');

sensor.on('change', () => console.log('A0 value:', sensor.value));
// Output appears in the browser console (F12 -> Console).`,

  analogScale: `// Read a sensor on A0 and scale raw 0-1023 to 0-100%.
const sensor = new five.Sensor({ pin: 'A0', threshold: 10 });

sensor.scale([0, 100]).on('change', () => {
  console.log('Sensor: ' + Math.round(sensor.scaled) + '%');
});`,

  servoSweep: `// Sweep a servo back and forth between 0 and 180 degrees.
// Wiring: servo signal (orange) -> pin 9, red -> 5V, brown -> GND.
// Small servos can run off the Uno's 5V; larger ones need their own
// power supply that shares GND with the Uno.
const servo = new five.Servo(9);
servo.sweep();`,

  servoButton: `// Each button press moves the servo between 0 and 180 degrees.
// Wiring: servo signal -> pin 9, button between pin 2 and GND.
const servo = new five.Servo(9);
const button = new five.Button(2);

let angle = 0;
button.on('press', () => {
  angle = (angle === 0) ? 180 : 0;
  servo.to(angle);
});`,

  motor: `// Run a DC motor through an H-bridge driver (L293D, L9110, etc.).
// Wiring: driver PWM/enable input -> pin 3, direction input -> pin 12.
// The motor itself is powered by your driver's motor supply.
const motor = new five.Motor({ pins: { pwm: 3, dir: 12 } });

motor.forward(200);
board.wait(2000, () => {
  motor.reverse(150);
  board.wait(2000, () => motor.stop());
});`,

  relay: `// Click a relay on and off every 2 seconds.
// Wiring: relay control pin -> 7 (most relay modules are active-high).
const relay = new five.Relay(7);

setInterval(() => relay.toggle(), 2000);
// Press "3. Stop" to halt the clicking.`,

  rgbCycle: `// Cycle an RGB LED (common cathode) through the rainbow.
// Wiring: red -> 9, green -> 10, blue -> 11 (all PWM pins), longest leg -> GND.
const rgb = new five.Led.RGB({ pins: { red: 9, green: 10, blue: 11 } });

const colors = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'white'];
let i = 0;
setInterval(() => {
  rgb.color(colors[i % colors.length]);
  i++;
}, 1000);`,

  i2cStub: `// I2C devices (character LCDs, IMUs, RTC clocks...) use two shared pins:
//   SDA -> A4, SCL -> A5, plus 5V and GND from the Uno.
//
// Example: a 16x2 LCD on a PCF8574 I2C backpack (address 0x27 on most
// backpacks — check the module's documentation or use an I2C scanner).
//
// const lcd = new five.LCD({ controller: 'PCF8574' });
// lcd.cursor(0, 0).print('Hello, Hailie!');
//
// Uncomment the two lines above once your LCD is wired up.`
};

const samplesSelect = document.getElementById('samplesSelect');

samplesSelect.addEventListener('change', () => {
  const code = SAMPLES[samplesSelect.value];
  if (!code || !window.editor) return;

  // Insert at the cursor (replacing any active selection), like typing it.
  const selection = window.editor.getSelection();
  window.editor.executeEdits('sample', [
    { range: selection, text: code, forceMoveMarkers: true }
  ]);
  window.editor.focus();

  // Rewind to the placeholder so picking the same sample again re-fires.
  samplesSelect.value = '';
});