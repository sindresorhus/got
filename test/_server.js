import http from 'http';
import https from 'https';
import pify from 'pify';
import getPort from 'get-port';

export const host = 'localhost';
const getPortify = pify(getPort);

export const createServer = () => {
	return getPortify()
		.then(port => {
			const s = http.createServer((req, resp) => s.emit(req.url, req, resp));

			s.host = host;
			s.port = port;
			s.url = `http://${host}:${port}`;
			s.protocol = 'http';

			s.listen = pify(s.listen);
			s.close = pify(s.close);

			return s;
		});
};

export const createSSLServer = (opts) => {
	return getPortify()
		.then(port => {
			const s = https.createServer(opts, (req, resp) => s.emit(req.url, req, resp));

			s.host = host;
			s.port = port;
			s.url = `https://${host}:${port}`;
			s.protocol = 'https';

			s.listen = pify(s.listen);
			s.close = pify(s.close);

			return s;
		});
};
