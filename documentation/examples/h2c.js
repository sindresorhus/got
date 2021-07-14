import http2 from 'http2-wrapper';
import got from '../../dist/source/index.js';

let sessions = {};
const getSession = ({origin}) => {
	if (sessions[origin] && !sessions[origin].destroyed) {
		return sessions[origin];
	}

	const session = http2.connect(origin);
	session.once('error', () => {
		delete sessions[origin];
	});

	sessions[origin] = session;

	return session;
};

const closeSessions = () => {
	for (const key in sessions) {
		sessions[key].close();
	}

	sessions = {};
};

const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				options.h2session = getSession(options.url);
				options.http2 = true;
				options.request = http2.request;
			}
		]
	}
});

const server = http2.createServer((request, response) => {
	response.end('{}');
});

server.listen(async () => {
	const url = `http://localhost:${server.address().port}`;
	const {body, headers} = await instance(url, {context: {h2c: true}});
	console.log(headers, body);

	closeSessions();
	server.close();
});
