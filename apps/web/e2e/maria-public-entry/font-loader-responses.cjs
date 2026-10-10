const { resolve } = require("node:path");

const fontFile = resolve(__dirname, "../../public/fonts/Format_1452.woff2");

function face(family, style, weight) {
  return `/* latin */
@font-face {
  font-family: '${family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url(${fontFile}) format('woff2');
}`;
}

module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap":
    face("Inter", "normal", "100 900"),
  "https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&display=swap":
    face("Jost", "normal", "300 600"),
  "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap": `${face("Cormorant Garamond", "normal", "300 500")}
${face("Cormorant Garamond", "italic", "300 500")}`,
};
