import babel from 'rollup-plugin-babel';

export default {
  entry: 'index.js',
  format: 'umd',
  plugins: [ babel() ],
  dest: 'release/jingle-media-session.js',
  moduleName: 'jingleMediaSession'
};
