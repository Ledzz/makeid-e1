import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
new App(root);
