import zlib from 'zlib';

export default typeof zlib.createBrotliDecompress === 'function';
