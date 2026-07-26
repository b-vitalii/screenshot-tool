const express = require('express');
const { runJob } = require('./runner');

const app = express();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const browsers = [];

app.use(express.json());

let status = {
    running: false,
    message: 'Ready',
    cancel: false,

    progress: 0,
    total: 0,
    // stage: '',

    workers: {},
    finished: false
};

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
    status.finished = false;
    status.message = '⏳ Running screenshots...';

    res.json({ ok: true });

    try {
        await runJob(req.body, status, browsers);

        console.log('🔥 AFTER runJob RETURNED');
        console.log('STATUS SNAPSHOT:', JSON.stringify(status, null, 2));
        status.progress = 100;
        status.running = false;
        status.finished = true;
        status.message = '✅ Screenshots completed';

    } catch (e) {
        status.finished = true;
        status.running = false;
        status.stage = '';

        if (e.message === 'CANCELLED') {
            status.message = '🛑 Cancelled';
        } else {
            status.message = `❌ ${e.message}`;
        }
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

