'use strict';
const fs = require('node:fs');

// Manutenzione separata dal centro: solo mount nuovo e nessuna credenziale.
function preparaVolume({ directory = '/var/lib/amr', filesystem = fs, uid = process.getuid() } = {}) {
  if (directory !== '/var/lib/amr' || uid !== 0) throw new Error('preparazione_volume_non_ammessa');
  const mount = filesystem.readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n').some(riga => riga.split(' ')[4] === directory);
  if (!mount) throw new Error('mount_volume_non_confermato');
  const fd = filesystem.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (!filesystem.fstatSync(fd).isDirectory()
        || filesystem.readdirSync(`/proc/self/fd/${fd}`).some(nome => nome !== 'lost+found')) {
      throw new Error('volume_non_nuovo');
    }
    // Lo stesso descriptor impedisce di seguire un pathname sostituito; nessuna ricorsione.
    filesystem.fchownSync(fd, 1000, 1000);
    filesystem.fchmodSync(fd, 0o700);
    const dopo = filesystem.fstatSync(fd);
    if (dopo.uid !== 1000 || dopo.gid !== 1000 || (dopo.mode & 0o7777) !== 0o700) {
      throw new Error('permessi_volume_non_confermati');
    }
    return { uid: dopo.uid, gid: dopo.gid, mode: '0700' };
  } finally {
    filesystem.closeSync(fd);
  }
}
if (require.main === module) {
  try { console.log(JSON.stringify({ volumePreparato: preparaVolume() })); }
  catch { console.error('Preparazione del volume non confermata.'); process.exitCode = 1; }
}
module.exports = { preparaVolume };
