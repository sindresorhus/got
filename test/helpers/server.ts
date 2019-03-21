import util from 'util';
import http from 'http';
import https from 'https';
import getPort from 'get-port';
import pem from 'pem';

export const host = 'localhost';

const createCertificate = util.promisify(pem.createCertificate);

export const createServer = async () => {
	const port = await getPort();

	const server = http.createServer((request, response) => {
		const event = decodeURI(request.url);
		if (server.listeners(event).length === 0) {
			response.writeHead(404, 'Not Found');
			response.end(`No listener for ${event}`);
		} else {
			server.emit(event, request, response);
		}
	}) as any;

	server.host = host;
	server.port = port;
	server.url = `http://${host}:${port}`;
	server.protocol = 'http';

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

	return server;
};

export const createSSLServer = async () => {
	const port = await getPort();

	const caKeys = await createCertificate({
		days: 1,
		selfSigned: true
	});

	const caRootKey = caKeys.serviceKey;
	const caRootCert = caKeys.certificate;

	const keys = await createCertificate({
		serviceCertificate: caRootCert,
		serviceKey: caRootKey,
		serial: Date.now(),
		days: 500,
		country: '',
		state: '',
		locality: '',
		organization: '',
		organizationUnit: '',
		commonName: 'sindresorhus.com'
	});

	const key = keys.clientKey;
	const cert = keys.certificate;

	const server = https.createServer({cert, key}, (request, response) => {
		server.emit(request.url, request, response);
	}) as any;

	server.host = host;
	server.port = port;
	server.url = `https://${host}:${port}`;
	server.protocol = 'https';
	server.caRootCert = caRootCert;

	server.listen = util.promisify(server.listen);
	server.close = util.promisify(server.close);

	return server;
};
