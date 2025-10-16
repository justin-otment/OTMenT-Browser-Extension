const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const extDir = path.resolve(__dirname, '../txt files'); // extension folder
const out = path.resolve(__dirname, '../extension.zip');

if (!fs.existsSync(extDir)) {
  console.error('Extension folder not found:', extDir);
  process.exit(2);
}

const zip = new AdmZip();
zip.addLocalFolder(extDir);
zip.writeZip(out);
console.log('ZIPPED_TO', out);
