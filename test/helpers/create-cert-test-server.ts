import https = require('https');
import express = require('express');
import pify = require('pify');
import pem = require('pem');

const createCertTestServer = async () => {
	const createCSR = pify(pem.createCSR);
	const createCertificate = pify(pem.createCertificate);

	const caCSRResult = await createCSR({commonName: 'authority'});
	const caResult = await createCertificate({
		csr: caCSRResult.csr,
		clientKey: caCSRResult.clientKey,
		selfSigned: true
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const serverCSRResult = await createCSR({commonName: 'localhost'});
	const serverResult = await createCertificate({
		csr: serverCSRResult.csr,
		clientKey: serverCSRResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert
	});
	const serverKey = serverResult.clientKey;
	const serverCert = serverResult.certificate;

	const server = express();
	(server as any).https = https.createServer(
		{
			key: serverKey,
			cert: serverCert,
			ca: caCert,
			requestCert: true,
			rejectUnauthorized: false // This should be checked by the test
		},
		server
	);

	server.set('etag', false);

	await pify((server as any).https.listen.bind((server as any).https))();

	(server as any).caKey = caKey;
	(server as any).caCert = caCert;
	(server as any).sslPort = (server as any).https.address().port;
	(server as any).sslUrl = `https://localhost:${((server as any).sslPort as number)}`;

	(server as any).close = () =>
		pify((server as any).https.close.bind((server as any).https))();

	return server;
};

export default createCertTestServer;
