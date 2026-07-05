import http2 from 'node:http2';
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
		if (!Object.hasOwn(sessions, key)) {
			continue;
		}

		sessions[key].close();
	}

	sessions = {};
};

const instance = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				options.h2session = getSession(options.url);
			},
		],
	},
});

const server = http2.createServer((request, response) => {
	response.end('{}');
});

server.listen(async () => {
	const url = `http://localhost:${server.address().port}`;
	const {body, headers} = await instance(url);
	console.log(headers, body);

	closeSessions();
	server.close();
});
