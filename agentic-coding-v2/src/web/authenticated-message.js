import { button, element } from "/dom.js";

async function imageBlob(response) {
	const limit = 5 * 1024 * 1024;
	const type = response.headers.get("content-type")?.split(";")[0];
	if (
		!response.ok ||
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)
	) {
		await response.body?.cancel();
		throw new Error("Image response unavailable");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Image body unavailable");
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error("Image exceeds the browser display limit");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return new Blob(chunks, { type });
}

// Parse in an inert template: no unauthenticated image request is dispatched before
// src removal. Only exact content-addressed attachment paths reach the capability.
export function authenticatedMessage(html, request) {
	const template = document.createElement("template");
	template.innerHTML = html;
	const content = element("div");
	const controllers = new Set();
	const urls = new Set();
	let active = true;
	const loads = new WeakMap();
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries)
				if (entry.isIntersecting) {
					observer.unobserve(entry.target);
					const load = loads.get(entry.target);
					if (load) void load();
				}
		},
		{ rootMargin: "160px" },
	);
	for (const img of template.content.querySelectorAll("img")) {
		const source = img.getAttribute("src") ?? "";
		img.removeAttribute("src");
		if (!/^\/attachments\/[a-f0-9]{64}$/.test(source)) {
			img.replaceWith(element("span", "[Image blocked]"));
			continue;
		}
		const wrapper = element("span", null, "authenticated-image");
		const status = element("span", "Image awaiting authenticated load…");
		img.hidden = true;
		let currentUrl = null;
		const release = () => {
			if (currentUrl) {
				URL.revokeObjectURL(currentUrl);
				urls.delete(currentUrl);
				currentUrl = null;
			}
		};
		img.onerror = () => {
			if (active) {
				release();
				img.hidden = true;
				status.hidden = false;
				status.textContent = "Image could not be decoded.";
				retry.hidden = false;
			}
		};
		const retry = button(`Retry image: ${img.alt || "attachment"}`, () =>
			load(),
		);
		retry.hidden = true;
		const load = async () => {
			if (!active) return;
			release();
			retry.hidden = true;
			const controller = new AbortController();
			controllers.add(controller);
			const timeout = setTimeout(() => controller.abort(), 15000);
			status.textContent = "Loading authenticated image…";
			try {
				const blob = await imageBlob(await request(source, controller.signal));
				if (!active) return;
				const url = URL.createObjectURL(blob);
				urls.add(url);
				currentUrl = url;
				img.src = url;
				img.hidden = false;
				status.hidden = true;
			} catch {
				if (active) {
					status.textContent =
						"Image unavailable (authentication, format, size or transport failure).";
					retry.hidden = false;
				}
			} finally {
				clearTimeout(timeout);
				controllers.delete(controller);
			}
		};
		img.replaceWith(wrapper);
		wrapper.append(img, status, retry);
		loads.set(wrapper, load);
		observer.observe(wrapper);
	}
	content.append(template.content);
	return {
		content,
		dispose: () => {
			active = false;
			observer.disconnect();
			for (const controller of controllers) controller.abort();
			for (const url of urls) URL.revokeObjectURL(url);
		},
	};
}
