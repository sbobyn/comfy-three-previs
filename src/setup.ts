import './director.css';
import { applyTheme, watchTheme } from './theme';
import { h } from './director-common';
import { loadSetup } from './director-setup';
applyTheme(); watchTheme(); // keep the theme the <head> script applied in step with the setting and the OS

const app = document.getElementById('app')!;
const main = h('main', {}, h('h1', {}, 'Setup'), h('p', { class: 'note' }, 'Checking…'));
app.replaceChildren(h('header', {}, h('a', { class: 'brand', href: '/' }, 'Comfy Previs'), h('a', { href: '/' }, '← Projects')), main);
void loadSetup().then(el => main.lastElementChild!.replaceWith(el));
