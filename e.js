const {app} = require('electron');
const got = require('.');

app.on('ready', async () => {
	const {body} = await got('http://oo.pl', {useElectronNet: true});
	console.log(body);
});
