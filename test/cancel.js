import test from 'ava';
import getPort from 'get-port';
import getStream from 'get-stream';
import PCancelable from 'p-cancelable';
import stream from 'stream';
import got from '../';
import {createServer} from './helpers/server';

const Readable = stream.Readable;

async function createAbortServer() {
  const t = await createServer();
  const aborted = new Promise((resolve, reject) => {
    t.on('/abort', (req, res) => {
      req.on('aborted', () => {
        resolve();
      });
      res.on('finish', reject.bind(this, new Error('Request finished instead of aborting')));

      getStream(req).then(() => {
        res.end();
      });
    });
  });

  await t.listen(t.port);

  return {
    aborted,
    url: `${t.url}/abort`
  };
}

test('cancel in-progress request', async t => {
	const helper = await createAbortServer();
	const body = new Readable({
		read() {}
	});
	body.push('1');

	const p = got(helper.url, {body});

	// Wait for the stream to be established before canceling
	setTimeout(() => {
		p.cancel();
		body.push(null);
	}, 100);

	await t.throws(p, PCancelable.CancelError);
	await t.notThrows(helper.aborted, 'Request finished instead of aborting.');
});

test.todo('cancel immediately');
