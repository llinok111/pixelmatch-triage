/**
 * Browser check: proves the unbundled ESM modules actually load and run in a browser engine.
 *
 * Browsers refuse ES modules from file:// URLs, so the repository is served over HTTP on a random
 * port and driven through the Chrome DevTools Protocol over a WebSocket. The verdict comes from
 * evaluating an expression inside the page, not from scraping console text, so a page's own inline
 * source can never be mistaken for a result.
 *
 * This file lives outside `test/` on purpose: `node --test` picks up every module under that
 * directory, and this script needs a browser binary plus Node's global WebSocket (Node 22+), so it
 * must not be mistaken for a unit test.
 *
 * Usage: node scripts/browser-check.mjs [path-to-chrome-or-edge]
 * Exit codes: 0 pass, 1 fail, 2 prerequisites missing (no browser, or no global WebSocket).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (typeof WebSocket === 'undefined') {
    console.error(`This check needs a global WebSocket (Node 22+); running ${process.version}.`);
    process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [
    process.argv[2],
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const browserPath = candidates.find(p => fs.existsSync(p));
if (!browserPath) {
    console.error('No Chrome/Edge binary found. Pass one as an argument or set CHROME_PATH.');
    process.exit(2);
}

const PAGE = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>pending</title></head><body>',
    '<pre id="out">running</pre>',
    '<script type="module">',
    'try {',
    '    const pixelmatch = (await import("/index.js")).default;',
    '    const {compare} = await import("/triage.js");',
    '    const W = 40, H = 30;',
    '    const white = () => new Uint8ClampedArray(W * H * 4).fill(255);',
    '    const a = white(), b = white();',
    '    for (let y = 5; y < 12; y++) for (let x = 5; x < 12; x++) {',
    '        const p = (y * W + x) * 4; b[p] = 0; b[p + 1] = 0; b[p + 2] = 0;',
    '    }',
    '    const core = pixelmatch(a, b, null, W, H);',
    '    const r = compare(a, b, W, H, {threshold: 0.05, annotate: true});',
    '    const g = r.regions[0];',
    '    window.__check = {',
    '        core,',
    '        regions: r.regions.length,',
    '        box: g ? [g.x, g.y, g.width, g.height] : null,',
    '        psnrFinite: Number.isFinite(r.psnr),',
    '        annotated: r.annotated ? r.annotated.length : 0,',
    '        expectedAnnotated: W * H * 4',
    '    };',
    '} catch (error) {',
    '    window.__check = {error: error.name + ": " + error.message};',
    '}',
    '</script></body></html>'
].join('\n');

/** Minimal CDP client over the Node 22 global WebSocket. */
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.next = 1;
        this.pending = new Map();
        ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const {resolve} = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                resolve(msg);
            }
        });
    }

    send(method, params = {}) {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.ws.send(JSON.stringify({id, method, params}));
        });
    }
}

const sleep = ms => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const server = http.createServer((request, response) => {
    const url = (request.url || '/').split('?')[0];
    if (url === '/' || url === '/test/browser-check.html') {
        response.writeHead(200, {'Content-Type': 'text/html'});
        response.end(PAGE);
        return;
    }
    const file = path.join(root, decodeURIComponent(url));
    if (!file.startsWith(root)) {
        response.writeHead(403);
        response.end();
        return;
    }
    fs.readFile(file, (error, data) => {
        if (error) {
            response.writeHead(404);
            response.end('not found');
            return;
        }
        const ext = path.extname(file);
        const type = ext === '.js' ? 'text/javascript' : (ext === '.json' ? 'application/json' : 'text/plain');
        response.writeHead(200, {'Content-Type': type});
        response.end(data);
    });
});

server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-triage-'));
    const debugPort = 9500 + Math.floor(Math.random() * 400);

    // CI runners execute as root with a constrained /dev/shm, and Chrome refuses to start as root
    // unless the sandbox is disabled. These flags are only passed where they are required.
    const platformFlags = process.platform === 'linux' ?
        ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] :
        [];

    /** @type {string[]} */
    const browserStderr = [];

    const child = execFile(browserPath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        ...platformFlags,
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debugPort}`,
        'about:blank'
    ], () => {
        // the browser's own exit is irrelevant: `finish` kills it after the check completes
    });

    if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            browserStderr.push(chunk);
            if (browserStderr.length > 40) browserStderr.shift();
        });
    }

    /** @return {string} the tail of the browser's stderr, for diagnosable failures */
    const browserDiagnostics = () => browserStderr.join('').trim().split('\n').slice(-8).join('\n');

    const finish = (code) => {
        try {
            child.kill();
        } catch {
            // already gone
        }
        server.close();
        setTimeout(() => process.exit(code), 100);
    };

    /*
     * Awaits inside these loops are deliberate: each iteration has to wait for an external
     * process (browser startup, page evaluation) and the number of attempts is bounded.
     */
    /* eslint-disable no-await-in-loop */

    /** Poll until the browser exposes its debugging endpoint (startup is asynchronous). */
    const waitForTargets = async () => {
        for (let attempt = 0; attempt < 60; attempt++) {
            // a browser that already exited will never open the port; stop waiting and say why
            if (child.exitCode !== null) return null;
            try {
                const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
                const list = await res.json();
                if (list && list.length > 0) return list;
            } catch {
                // not listening yet
            }
            await sleep(250);
        }
        return null;
    };

    /** Poll until the page has published its verdict. */
    const waitForVerdict = async (cdp) => {
        for (let attempt = 0; attempt < 60; attempt++) {
            await sleep(200);
            const reply = await cdp.send('Runtime.evaluate', {
                expression: 'JSON.stringify(window.__check || null)',
                returnByValue: true
            });
            const value = reply.result && reply.result.result && reply.result.result.value;
            if (value && value !== 'null') return JSON.parse(value);
        }
        return null;
    };

    /* eslint-enable no-await-in-loop */

    const run = async () => {
        const targets = await waitForTargets();
        if (!targets) {
            const code = child.exitCode;
            const detail = browserDiagnostics();
            throw new Error(`browser did not expose a debugging target${code !== null ? ` (exited with ${code})` : ''}${detail ? `\n${detail}` : ''}`);
        }

        const page = targets.find(t => t.type === 'page') || targets[0];
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve);
            ws.addEventListener('error', reject);
        });

        const cdp = new Cdp(ws);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Page.navigate', {url: `http://127.0.0.1:${port}/test/browser-check.html`});

        const check = await waitForVerdict(cdp);

        ws.close();
        if (!check) throw new Error('the page never reported a result');
        return check;
    };

    run().then((check) => {
        console.log('browser:', path.basename(browserPath));
        if (check.error) {
            console.error('page error:', check.error);
            finish(1);
            return;
        }
        const checks = [
            ['core comparison returns 49', check.core === 49],
            ['one region is reported', check.regions === 1],
            ['region box is 7x7 at (5,5)', Array.isArray(check.box) && check.box.join(',') === '5,5,7,7'],
            ['PSNR is a finite number', check.psnrFinite === true],
            ['annotated buffer is width*height*4', check.annotated === check.expectedAnnotated]
        ];
        for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}`);
        const failed = checks.filter(([, ok]) => !ok).length;
        console.log(failed === 0 ? 'browser check passed' : `browser check failed (${failed}/${checks.length})`);
        finish(failed === 0 ? 0 : 1);
    }).catch((error) => {
        console.error('browser check failed:', error.message);
        finish(1);
    });
});
