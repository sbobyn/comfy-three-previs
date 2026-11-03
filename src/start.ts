import './director-report'; // first: its error buffer starts at boot
import './director.css';
import { applyTheme, watchTheme } from './theme';
import { renderHome } from './director-home';
applyTheme(); watchTheme(); // keep the theme the <head> script applied in step with the setting and the OS

renderHome();
