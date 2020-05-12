import {Readable} from 'stream';

// TODO: Update `get-stream`

const getBuffer = async (stream: Readable) => {
	const chunks = [];

	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk));
	}

	return Buffer.concat(chunks);
};

export default getBuffer;
