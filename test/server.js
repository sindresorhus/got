import http from 'http';
import https from 'https';

export const host = 'localhost';
export let port = 6767;
export let portSSL = 16167;

export const createServer = port2 => {
	port = port2 || ++port;

	const s = http.createServer((req, resp) => s.emit(req.url, req, resp));

	s.host = host;
	s.port = port;
	s.url = `http://${host}:${port}`;
	s.protocol = 'http';

	return s;
};

export const createSSLServer = (portSSL2, opts) => {
	portSSL = portSSL2 || ++portSSL;

	const s = https.createServer(opts, (req, resp) => s.emit(req.url, req, resp));

	s.host = host;
	s.port = portSSL;
	s.url = `https://${host}:${portSSL}`;
	s.protocol = 'https';

	return s;
};
