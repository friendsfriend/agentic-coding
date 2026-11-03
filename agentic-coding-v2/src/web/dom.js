export function element(tag, text, className) {
	const el = document.createElement(tag);
	if (text) el.textContent = text;
	if (className) el.className = className;
	return el;
}
export function button(label, action) {
	const el = element("button", label);
	el.type = "button";
	el.onclick = async () => {
		try {
			await action();
		} catch (error) {
			const status = document.getElementById("connection");
			if (status) status.textContent = String(error);
		}
	};
	return el;
}
