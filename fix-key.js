const fs = require('fs');
const json = JSON.parse(fs.readFileSync('C:\\Users\\ning_\\Downloads\\line-bot-490313-23f8ff0c53b7.json'));
console.log(json.private_key);