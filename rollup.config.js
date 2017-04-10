import babel from 'rollup-plugin-babel';

export default {
  entry: 'index.js',
  format: 'umd',
  plugins: [ babel() ],
  dest: 'tmp/jingle-media-session.js',
  moduleName: 'jingleMediaSession'
};
