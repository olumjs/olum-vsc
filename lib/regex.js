const regex = {
  ifTag: /<(if)(?=[\s>\/])([\s\S]*?)>|<\/(if)>/g,
  elseIfTag: /<(else-if)(?=[\s>\/])([\s\S]*?)>|<\/(else-if)>/g,
  elseTag: /<(else)(?=[\s>\/])([\s\S]*?)>|<\/(else)>/g,
  forTag: /<(for)(?=[\s>\/])([\s\S]*?)>|<\/(for)>/g,
  showTag: /<(show)(?=[\s>\/])([\s\S]*?)>|<\/(show)>/g,
  compTag: /<([A-Z][^\/>]+)\/>/g, // self closing tag with pascal case
  compTag2: /<([A-Z][^\/>]+)>|<\/([A-Z][^\/>]+)>/g, // normal tag with pascal case
};
module.exports = regex;
