import zlib from 'zlib';

export default typeof (zlib as any).createBrotliDecompress === 'function';
