const got = require('../../');

(async () => {
  try {
    await got('https://google.com');
  } catch {
    process.exit(1);
  }
})();
