'use strict';

const { execFile } = require('child_process');
const qrcode = require('qrcode-generator');

function mount(app) {
  let funnelCache = { ts: 0, url: null };
  const FUNNEL_TTL = 60 * 1000;

  let funnelInVolo = null;
  function tailscalePublicUrl(cb) {
    if (Date.now() - funnelCache.ts < FUNNEL_TTL) return cb(funnelCache.url);
    if (funnelInVolo) { funnelInVolo.push(cb); return; }
    funnelInVolo = [cb];
    const bins = ['/usr/local/bin/tailscale', 'tailscale'];
    let i = 0;
    const done = url => {
      funnelCache = { ts: Date.now(), url };
      const attese = funnelInVolo; funnelInVolo = null;
      for (const f of attese) f(url);
    };
    const tryNext = () => {
      if (i >= bins.length) return done(null);
      execFile(bins[i++], ['funnel', 'status'], { timeout: 3000 }, (err, stdout) => {
        if (err) return err.code === 'ENOENT' ? tryNext() : done(null);
        const m = String(stdout).match(/https:\/\/[^\s]+/);
        done(m ? m[0].replace(/\/$/, '') : null);
      });
    };
    tryNext();
  }

  app.get('/api/public-url', (req, res) => {
    tailscalePublicUrl(url => {
      if (!url) return res.json({ url: null, svg: null });
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      res.json({ url, svg: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) });
    });
  });
  return { tailscalePublicUrl };
}

module.exports = { mount };
