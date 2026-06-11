const {google} = require('googleapis');
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('C:/Users/ning_/line-bot/service-account.json'));
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: j.client_email,
    private_key: j.private_key,
    private_key_id: j.private_key_id
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
auth.getAccessToken()
  .then(t => console.log('✅ Token OK:', t.substring(0,20)))
  .catch(e => console.log('❌ Error:', e.message));