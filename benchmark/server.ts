import {AddressInfo} from 'net';
import https from 'https';
// @ts-expect-error No types
import createCert from 'create-cert';

(async () => {
	const keys = await createCert({days: 365, commonName: 'localhost'});

	const server = https.createServer(keys, (_request, response) => {
		response.end('ok');
	}).listen(8080, () => {
		const {port} = server.address() as AddressInfo;
		console.log(`Listening at https://localhost:${port}`);
	});
})();
