const {PassThrough} = require('stream');

const x = new PassThrough();
const y = new PassThrough();

y.setEncoding('base64');
y.on('data', chunk => {
	console.log(chunk.toString());
});

x.pipe(y);

x.write(Buffer.from('asdf').toString('base64'));
