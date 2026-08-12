const { EventEmitter } = require('events');
const express = require('express');
const { runJob } = require('./runner');
const { analyze } = require('./textAudit');

const app = express();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const browsers = [];

// server.js is required from main.js, i.e. it lives in the very same process as
// Electron's `app`. So the "run finished" signal needs no IPC and no preload —
// main.js just listens here and puts a badge on the dock.
const events = new EventEmitter();

app.use(express.json());

let status = {
    running: false,
    message: 'Ready',
    cancel: false,

    progress: 0,
    total: 0,
    // stage: '',

    workers: {},
    presets: [],
    issues: 0,
    broken: 0,
    suspect: 0,
    finished: false
};

// last text-audit report, kept in memory and mirrored to reports/latest.json
let report = null;
const REPORT_DIR = path.join(__dirname, 'reports');
const REPORT_FILE = path.join(REPORT_DIR, 'latest.json');

function saveReport(data) {
    report = data;
    try {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(REPORT_FILE, JSON.stringify(data));
    } catch (e) {
        console.error('report write failed', e);
    }
}

const EMPTY_REPORT = {
    total: 0, broken: 0, suspect: 0, rawIssues: 0, shots: 0,
    languages: [], byType: {}, byLang: {}, findings: []
};

function loadReport() {
    try {
        if (fs.existsSync(REPORT_FILE)) report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch (e) { report = null; }
}

// UI
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

//version
app.get('/version', (req, res) => {
    const pkg = require('./package.json');
    res.json({ version: pkg.version });
});

// статус

app.get('/status', (req, res) => {

    console.log({
        running: status.running,
        finished: status.finished,
        progress: status.progress,
        total: status.total,
        message: status.message
    });

    const stage = Object.values(status.workers)
        .map(w => `${w.lang}${w.mode ? ' - ' + w.mode : ''}`)
        .join(' | ');

    res.json({
        ...status,
        stage
    });
});

// запуск
app.post('/run', async (req, res) => {
    if (status.running) {
        return res.status(400).json({
            ok: false,
            message: 'Job already running'
        });
    }

    // const dir = path.join(__dirname, 'screenshots');
    // if (fs.existsSync(dir)) {
    //     fs.rmSync(dir, { recursive: true, force: true });
    // }
    // fs.mkdirSync(dir, { recursive: true });

    status.running = true;
    status.cancel = false;
    status.progress = 0;
    status.total = 0;
    status.workers = {};
    status.presets = [];
    status.issues = 0;
    status.broken = 0;
    status.suspect = 0;
    status.finished = false;
    status.message = '⏳ Running screenshots...';
    report = null;

    res.json({ ok: true });

    try {
        const result = await runJob(req.body, status, browsers);

        // text audit — never let a bad analysis fail a good screenshot run
        if (req.body.textChecks === false) {
            saveReport({ ...EMPTY_REPORT, generatedAt: new Date().toISOString(), skipped: true });
        } else {
            try {
                const shots = (result && result.shots) || [];
                const data = analyze(shots, {
                    suspects: req.body.suspects !== false,
                    overlap: req.body.overlapCheck === true
                });
                data.generatedAt = new Date().toISOString();
                data.game = req.body.gameName || null;
                saveReport(data);
                status.issues = data.total;
                status.broken = data.broken;
                status.suspect = data.suspect;
                console.log(`text audit: ${data.total} finding(s) from ${data.rawIssues} raw hit(s) — ${data.broken} broken, ${data.suspect} suspect, over ${data.shots} shot(s), ${data.texts} visible text(s)`);
                console.log(`  filtered out: ${data.skipped.hidden} hidden (other paytable pages), ${data.skipped.offscreen} fully off-screen`);
            } catch (e) {
                console.error('text audit failed', e);
            }
        }

        status.progress = 100;
        status.running = false;
        status.finished = true;
        status.message = status.issues
            ? `✅ Done · ⚠️ ${status.issues} finding${status.issues === 1 ? '' : 's'}`
            : '✅ Screenshots completed';

        events.emit('run-finished', { ok: true, findings: status.issues || 0, cancelled: false });

    } catch (e) {
        status.finished = true;
        status.running = false;
        status.stage = '';

        if (e.message === 'CANCELLED') {
            status.message = '🛑 Cancelled';
        } else {
            status.message = `❌ ${e.message}`;
        }

        events.emit('run-finished', {
            ok: false,
            findings: status.issues || 0,
            cancelled: e.message === 'CANCELLED'
        });
    } finally {
        browsers.length = 0;
        console.log('🧨 FINALLY BLOCK ENTERED');
        status.cancel = false;
        status.workers = {};
        console.log('🧾 FINAL STATUS:', JSON.stringify(status, null, 2));
    }
});

app.post('/cancel', async (req, res) => {

    if (!status.running) {
        return res.json({ ok: false, message: 'No running job' });
    }

    status.cancel = true;
    status.running = false;
    status.finished = true;

    status.message = '🛑 Cancelling...';

    status.progress = 0;
    status.total = 0;
    status.stage = '';
    status.workers = {};

    const toClose = [...browsers];

    browsers.length = 0;

    await Promise.allSettled(
        toClose.map(b => b.close())
    );

    res.json({ ok: true });
});

app.get('/issues', (req, res) => {
    if (!report) loadReport();
    res.json(report || EMPTY_REPORT);
});

app.get('/screenshots', (req, res) => {
    const baseDir = path.join(__dirname, 'screenshots');

    function readDir(dir) {
        if (!fs.existsSync(dir)) return [];

        return fs.readdirSync(dir)
            .sort((a, b) =>
                a.localeCompare(b, undefined, {
                    numeric: true,
                    sensitivity: 'base'
                })
            )
            .map(name => {

                const full = path.join(dir, name);
                const stat = fs.statSync(full);

                if (stat.isDirectory()) {
                    return {
                        name,
                        type: 'folder',
                        children: readDir(full)
                    };
                }

                return {
                    name,
                    type: 'file',
                    url: `/file/${path.relative(baseDir, full).replace(/\\/g, '/')}`
                };
            });
    }

    res.json(readDir(baseDir));
});

// app.use('/file', express.static(path.join(__dirname, 'screenshots')));
app.use('/file', express.static(path.join(__dirname, 'screenshots'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

app.post('/cleanup', (req, res) => {
    const dir = path.join(__dirname, 'screenshots');

    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, {
                recursive: true,
                force: true
            });
        }

        fs.mkdirSync(dir, { recursive: true });

        res.json({ ok: true });

    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false });
    }
});

app.get('/download-zip', (req, res) => {
    const dir = path.join(__dirname, 'screenshots');

    if (!fs.existsSync(dir)) {
        return res.status(404).send('No screenshots found');
    }

    res.setHeader('Content-Type', 'application/zip');
    // res.setHeader('Content-Disposition', 'attachment; filename=screenshots.zip');
    // const gameName = req.query.name || 'screenshots';
    const gameName = 'screenshots';
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename=${gameName}_${today}.zip`);

    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    archive.on('error', err => {
        console.error(err);
        res.status(500).send('Zip error');
    });

    archive.pipe(res);

    archive.directory(dir, false);

    archive.finalize();
});

app.listen(3000, () => {
    console.log('UI running on http://localhost:3000');
});

module.exports = { events };

