import {Readable} from 'stream';

// TODO: Update https://github.com/sindresorhus/get-stream

const getBuffer = async (stream: Readable) => {
	const chunks = [];
	let length = 0;

	for await (const chunk of stream) {
		chunks.push(chunk);
		length += Buffer.byteLength(chunk);
	}

	if (Buffer.isBuffer(chunks[0])) {
		return Buffer.concat(chunks, length);
	}

	return Buffer.from(chunks.join(''));
};

export default getBuffer;
