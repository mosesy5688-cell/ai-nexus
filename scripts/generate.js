const fs = require('fs');
const CryptoJS = require('crypto-js');

const realData = {
  image: [
    { name: "Fotor AI", free: "Yes", limit: "8 credits + check-ins", source: "https://www.fotor.com/ai-art-generator/" },
    { name: "Vheer AI", free: "Yes", limit: "Unlimited", source: "https://vheer.com" },
    { name: "Copilot Designer", free: "Yes", limit: "15/day", source: "https://copilot.microsoft.com" }
  ],
  logo: [
    { name: "Canva AI Logo", free: "Yes", limit: "50/day", source: "https://www.canva.com/create/logos" },
    { name: "Looka", free: "Yes", limit: "Hundreds", source: "https://looka.com" }
  ],
  video: [
    { name: "DaVinci Resolve", free: "Yes", limit: "Full free", source: "https://www.blackmagicdesign.com" },
    { name: "CapCut", free: "Yes", limit: "Unlimited", source: "https://www.capcut.com" }
  ],
  writing: [
    { name: "ChatGPT", free: "Yes", limit: "Unlimited", source: "https://chat.openai.com" }
  ],
  resume: [
    { name: "Rezi", free: "Yes", limit: "Free checker", source: "https://rezi.ai" }
  ]
};

Object.keys(realData).forEach(k => {
  const data = realData[k];
  const hash = CryptoJS.SHA256(JSON.stringify(data)).toString();
  fs.writeFileSync(\`src/content/auto/\${k}.json\`, JSON.stringify({ data, hash, updated: new Date().toISOString() }));
});
console.log('5 stations updated with real data!');
