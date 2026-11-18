import { render } from "preact";
import { App } from "./options-app/App";

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
