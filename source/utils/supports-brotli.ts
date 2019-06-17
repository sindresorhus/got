import zlib = require('zlib');

export default typeof zlib.createBrotliDecompress === 'function';
