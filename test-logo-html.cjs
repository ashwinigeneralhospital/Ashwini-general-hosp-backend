const { getHospitalLogoDataUri } = require('./dist/utils/logo.js');
const fs = require('fs');

console.log('Testing logo HTML generation...');

const logoDataUri = getHospitalLogoDataUri();
console.log('Logo loaded:', logoDataUri ? 'YES' : 'NO');
console.log('Logo length:', logoDataUri ? logoDataUri.length : 0);

if (logoDataUri) {
  const testHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logo Test</title>
  <style>
    .hospital-logo {
      width: 60px;
      height: 60px;
      display: block;
    }
    .hospital-logo img {
      width: 60px !important;
      height: 60px !important;
      object-fit: contain;
      display: block;
      max-width: none !important;
    }
  </style>
</head>
<body>
  <div class="hospital-logo">
    ${logoDataUri ? `<img src="${logoDataUri}" alt="Ashwini General Hospital Logo" />` : '<div style="font-size:24px;font-weight:bold;">🏥</div>'}
  </div>
  <p>Logo should appear above this text.</p>
</body>
</html>`;

  fs.writeFileSync('test-logo.html', testHtml);
  console.log('Test HTML written to test-logo.html');
  console.log('HTML contains img tag:', testHtml.includes('<img'));
  console.log('HTML contains data:image:', testHtml.includes('data:image'));
} else {
  console.log('No logo data URI generated!');
}
