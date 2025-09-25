import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const UPLOAD_DIR = path.join(__dirname, '../../trading-algos');
const INDEX_FILE = path.join(UPLOAD_DIR, 'index.json');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function loadIndex() {
  return fs.existsSync(INDEX_FILE) ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) : [];
}
function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

export class AlgoService {
  upload(req, res) {
    const { file, body } = req;
    const dest = path.join(UPLOAD_DIR, file.originalname);
    fs.renameSync(file.path, dest);

    const index = loadIndex();
    const systemId = Date.now().toString(36);
    index.push({ systemId, file: dest, name: body.name || file.originalname, status: 'stopped' });
    saveIndex(index);

    res.json({ ok: true, systemId });
  }

  run(req, res) {
    const { systemId } = req.body;
    const index = loadIndex();
    const algo = index.find(x => x.systemId === systemId);
    if (!algo) return res.status(404).json({ ok: false });

    exec(`pm2 start ${algo.file} --name ${systemId}`, (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      algo.status = 'running';
      saveIndex(index);
      res.json({ ok: true });
    });
  }

  stop(req, res) {
    const { systemId } = req.body;
    exec(`pm2 stop ${systemId}`, () => {
      const index = loadIndex();
      const algo = index.find(x => x.systemId === systemId);
      if (algo) algo.status = 'stopped';
      saveIndex(index);
      res.json({ ok: true });
    });
  }

  async allocate(req, reply) {
  const { systemId, amount } = req.body;
  const index = loadIndex();
  const algo = index.find(x => x.systemId === systemId);
  if (!algo) return reply.status(404).send({ ok: false });

  algo.allocation = amount;
  saveIndex(index);

  pm2.connect(() => {
    pm2.restart(systemId, {
      env: { ALLOCATION: String(amount) }
    }, (err) => {
      pm2.disconnect();
      if (err) return reply.status(500).send({ ok: false, error: err.message });
      reply.send({ ok: true });
    });
  });
}

async withdraw(req, reply) {
  const { systemId, amount } = req.body;
  const index = loadIndex();
  const algo = index.find(x => x.systemId === systemId);
  if (!algo) return reply.status(404).send({ ok: false });

  const newAlloc = (algo.allocation || 0) - amount;
  if (newAlloc <= 0) {
    algo.allocation = 0;
    algo.status = 'stopped';
    saveIndex(index);

    pm2.stop(systemId, () => {
      reply.send({ ok: true });
    });
  } else {
    algo.allocation = newAlloc;
    saveIndex(index);

    pm2.restart(systemId, {
      env: { ALLOCATION: String(newAlloc) }
    }, () => {
      reply.send({ ok: true });
    });
  }
}

  discovery(req, reply) {
    const index = loadIndex();
    reply.send(index);
  }

  running(req, reply) {
    pm2.connect(() => {
      pm2.list((err, list) => {
        pm2.disconnect();
        if (err) return reply.status(500).send({ error: err.message });
        const running = list.map(p => ({
          systemId: p.name,
          pid: p.pid,
          status: p.pm2_env.status,
          allocation: p.pm2_env.env?.ALLOCATION,
        }));
        reply.send(running);
      });
    });
  }



}
