const API_BASE = "/api/threads";
const ASSET_API = "/api/assets";
const PROFILE_API = "/api/profile";
const DEFAULT_PROFILE = {
  name: "Sam's Notes",
  imageUrl: "",
};

const state = {
  threads: [],
  profile: { ...DEFAULT_PROFILE },
  expandedThreadIds: new Set(),
  saveTimers: new Map(),
  savingThreadIds: new Set(),
  savingProfile: false,
  activePasteTarget: null,
  error: "",
};

const elements = {
  activeFileLabel: document.querySelector("#activeFileLabel"),
  collapseAllButton: document.querySelector("#collapseAllButton"),
  createThreadButton: document.querySelector("#createThreadButton"),
  emptyNewThreadButton: document.querySelector("#emptyNewThreadButton"),
  emptyState: document.querySelector("#emptyState"),
  expandAllButton: document.querySelector("#expandAllButton"),
  newThreadButton: document.querySelector("#newThreadButton"),
  reloadButton: document.querySelector("#reloadButton"),
  searchInput: document.querySelector("#searchInput"),
  storageStatus: document.querySelector("#storageStatus"),
  threadCount: document.querySelector("#threadCount"),
  threadDialog: document.querySelector("#threadDialog"),
  threadImageInput: document.querySelector("#threadImageInput"),
  threadPendingImages: document.querySelector("#threadPendingImages"),
  threadList: document.querySelector("#threadList"),
  threadTemplate: document.querySelector("#threadTemplate"),
  threadTextInput: document.querySelector("#threadTextInput"),
  messageCount: document.querySelector("#messageCount"),
  profileAvatar: document.querySelector("#profileAvatarVisual"),
  profileImageInput: document.querySelector("#profileImageInput"),
  profileNameInput: document.querySelector("#profileNameInput"),
  profileTitle: document.querySelector("#profileTitle"),
};

const newThreadFiles = [];

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createMessage(text, images = []) {
  return {
    id: createId(),
    text: text.trim(),
    images,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeThread(thread) {
  const now = new Date().toISOString();
  return {
    id: thread.id || createId(),
    createdAt: thread.createdAt || now,
    updatedAt: thread.updatedAt || thread.createdAt || now,
    messages: Array.isArray(thread.messages)
      ? thread.messages
          .filter((message) => typeof message.text === "string")
          .map((message) => ({
            id: message.id || createId(),
            text: message.text,
            images: Array.isArray(message.images)
              ? message.images.filter((image) => image && typeof image.url === "string")
              : [],
            createdAt: message.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || now,
          }))
      : [],
  };
}

function normalizeProfile(profile) {
  return {
    name:
      typeof profile?.name === "string" && profile.name.trim()
        ? profile.name.trim()
        : DEFAULT_PROFILE.name,
    imageUrl: typeof profile?.imageUrl === "string" ? profile.imageUrl : DEFAULT_PROFILE.imageUrl,
  };
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const message = await response.text();
    const error = new Error(message || `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function uploadImage(file) {
  const response = await fetch(ASSET_API, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Image upload failed with ${response.status}`);
  }

  const asset = await response.json();
  return {
    url: asset.url,
    name: file.name,
  };
}

async function uploadImages(files) {
  return Promise.all(files.map((file) => uploadImage(file)));
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function bindAutoGrow(textarea) {
  autoGrow(textarea);
  textarea.addEventListener("input", () => autoGrow(textarea));
}

function renderPendingImages(container, files, onRemove) {
  container.replaceChildren();
  files.forEach((file, index) => {
    const item = document.createElement("div");
    const image = document.createElement("img");
    const label = document.createElement("span");
    const remove = document.createElement("button");

    item.className = "pending-image";
    image.alt = "Pending image attachment";
    label.textContent = file.name || "Pasted image";
    remove.className = "remove-pending-image";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => onRemove(index));

    item.append(image, label, remove);
    container.append(item);

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      image.src = reader.result;
    });
    reader.readAsDataURL(file);
  });
}

function appendImageFiles(fileList, files, container) {
  Array.from(fileList)
    .filter((file) => file.type.startsWith("image/"))
    .forEach((file) => files.push(file));

  const rerender = () => {
    renderPendingImages(container, files, (index) => {
      files.splice(index, 1);
      rerender();
    });
  };
  rerender();
}

function extensionForImageType(type) {
  if (type === "image/jpeg") {
    return "jpg";
  }
  return type.replace("image/", "") || "png";
}

function imageFileFromBlob(blob, index = 0) {
  if (!blob) {
    return null;
  }
  if (blob instanceof File && blob.name) {
    return blob;
  }
  const extension = extensionForImageType(blob.type);
  return new File([blob], `pasted-image-${Date.now()}-${index}.${extension}`, { type: blob.type });
}

function imageFilesFromPasteEvent(event) {
  const seen = new Set();
  const files = [];
  const candidates = [
    ...Array.from(event.clipboardData?.files || []),
    ...Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()),
  ];

  candidates
    .filter(Boolean)
    .filter((file) => file.type.startsWith("image/"))
    .map((file, index) => imageFileFromBlob(file, index))
    .filter(Boolean)
    .forEach((file) => {
      const key = `${file.type}:${file.size}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      files.push(file);
    });

  return files;
}

function handleImagePaste(event, files, container) {
  const pastedFiles = imageFilesFromPasteEvent(event);
  if (!pastedFiles.length) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  appendImageFiles(pastedFiles, files, container);
  return true;
}

function bindImagePaste(target, files, container) {
  const activate = () => {
    state.activePasteTarget = { files, container };
  };
  target.addEventListener("focusin", activate);
  target.addEventListener("pointerdown", activate);
  target.addEventListener("paste", (event) => {
    handleImagePaste(event, files, container);
  });
}

function renderMessageImages(container, message) {
  container.replaceChildren();
  if (!message.images.length) {
    return;
  }

  message.images.forEach((image) => {
    const link = document.createElement("a");
    const thumbnail = document.createElement("img");
    link.href = image.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    thumbnail.className = "message-image";
    thumbnail.src = image.url;
    thumbnail.alt = image.name || "Attached image";
    link.append(thumbnail);
    container.append(link);
  });
}

function renderFirstMessageImages(container, message) {
  container.replaceChildren();
  if (!message.images.length) {
    return;
  }

  message.images.forEach((image) => {
    const thumbnail = document.createElement("img");
    thumbnail.src = image.url;
    thumbnail.alt = image.name || "Attached image";
    container.append(thumbnail);
  });
}

function renderAvatar(container, profile) {
  container.replaceChildren();
  container.style.backgroundImage = "";
  if (profile.imageUrl) {
    const image = document.createElement("img");
    image.src = profile.imageUrl;
    image.alt = "";
    container.append(image);
    return;
  }
  const fallback = document.createElement("span");
  fallback.textContent = profile.name.slice(0, 1).toUpperCase();
  container.append(fallback);
}

function renderProfile() {
  const profile = state.profile;
  document.title = profile.name;
  elements.profileTitle.textContent = profile.name;
  elements.profileNameInput.value = profile.name;
  elements.profileTitle.hidden = false;
  elements.profileNameInput.hidden = true;
  renderAvatar(elements.profileAvatar, profile);
}

async function loadProfile() {
  try {
    const data = await requestJson(PROFILE_API);
    state.profile = normalizeProfile(data.profile);
    renderProfile();
  } catch (error) {
    state.profile = { ...DEFAULT_PROFILE };
    console.error(error);
    renderProfile();
  }
}

async function saveProfile(nextProfile) {
  state.error = "";
  state.savingProfile = true;
  updateStorageStatus();

  try {
    const saved = await requestJson(PROFILE_API, {
      method: "POST",
      body: JSON.stringify(nextProfile),
    });
    state.profile = normalizeProfile(saved.profile);
    renderProfile();
    render();
  } catch (error) {
    state.error = "The profile could not be saved.";
    console.error(error);
    render();
  } finally {
    state.savingProfile = false;
    updateStorageStatus();
  }
}

async function loadThreads() {
  try {
    state.error = "";
    const data = await requestJson(API_BASE);
    state.threads = Array.isArray(data.threads) ? data.threads.map(normalizeThread) : [];
    state.threads = state.threads.filter((thread) => thread.messages.length > 0);
    sortThreads();
    render();
  } catch (error) {
    state.error = "Start the local server with python3 server.py to load file-backed notes.";
    console.error(error);
    render();
  }
}

async function createThread(text, imageFiles = []) {
  const images = await uploadImages(imageFiles);
  const firstMessage = createMessage(text, images);
  const thread = normalizeThread({
    id: createId(),
    createdAt: firstMessage.createdAt,
    updatedAt: firstMessage.updatedAt,
    messages: [firstMessage],
  });

  const savedThread = await requestJson(API_BASE, {
    method: "POST",
    body: JSON.stringify(thread),
  });

  state.threads.unshift(normalizeThread(savedThread.thread));
  state.expandedThreadIds.add(savedThread.thread.id);
  render();
}

async function saveThreadNow(thread) {
  state.savingThreadIds.add(thread.id);
  updateStorageStatus();

  try {
    const savedThread = await requestJson(`${API_BASE}/${encodeURIComponent(thread.id)}`, {
      method: "PUT",
      body: JSON.stringify(thread),
    });
    const index = state.threads.findIndex((item) => item.id === thread.id);
    if (index >= 0) {
      state.threads[index] = normalizeThread(savedThread.thread);
    }
    sortThreads();
  } catch (error) {
    state.error = "A thread could not be saved. Check the local server output.";
    console.error(error);
  } finally {
    state.savingThreadIds.delete(thread.id);
    render();
  }
}

function scheduleThreadSave(thread) {
  state.error = "";
  window.clearTimeout(state.saveTimers.get(thread.id));
  state.saveTimers.set(
    thread.id,
    window.setTimeout(() => {
      saveThreadNow(thread);
    }, 500),
  );
  updateStorageStatus();
}

async function deleteThread(thread) {
  window.clearTimeout(state.saveTimers.get(thread.id));
  state.saveTimers.delete(thread.id);
  await requestJson(`${API_BASE}/${encodeURIComponent(thread.id)}`, {
    method: "DELETE",
  });
  state.threads = state.threads.filter((item) => item.id !== thread.id);
  state.expandedThreadIds.delete(thread.id);
  render();
}

function updateStorageStatus() {
  if (state.error) {
    if (elements.storageStatus) {
      elements.storageStatus.textContent = "Server disconnected";
    }
    elements.activeFileLabel.textContent = state.error;
    return;
  }

  if (state.savingThreadIds.size > 0 || state.savingProfile) {
    if (elements.storageStatus) {
      elements.storageStatus.textContent = "Saving";
    }
    elements.activeFileLabel.textContent = state.savingProfile
      ? "Writing profile changes to profile.json"
      : "Writing changes to threads/";
    return;
  }

  elements.activeFileLabel.textContent = "";
}

function updateStats() {
  const messageTotal = state.threads.reduce((sum, thread) => sum + thread.messages.length, 0);
  elements.threadCount.textContent = String(state.threads.length);
  elements.messageCount.textContent = String(messageTotal);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function sortThreads() {
  state.threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function getVisibleThreads() {
  const query = elements.searchInput.value.trim().toLowerCase();
  if (!query) {
    return state.threads;
  }

  return state.threads.filter((thread) =>
    thread.messages.some((message) => message.text.toLowerCase().includes(query)),
  );
}

function render() {
  sortThreads();
  const visibleThreads = getVisibleThreads();
  elements.threadList.replaceChildren();
  elements.emptyState.hidden = state.threads.length > 0 || Boolean(state.error);
  elements.threadList.hidden = state.threads.length === 0 && !state.error;

  if (state.error) {
    const errorPanel = document.createElement("article");
    errorPanel.className = "thread error-panel";
    errorPanel.textContent = state.error;
    elements.threadList.append(errorPanel);
  } else {
    visibleThreads.forEach((thread) => {
      elements.threadList.append(renderThread(thread));
    });
  }

  updateStats();
  updateStorageStatus();
}

function renderThread(thread) {
  const fragment = elements.threadTemplate.content.cloneNode(true);
  const root = fragment.querySelector(".thread");
  const toggle = fragment.querySelector(".thread-toggle");
  const body = fragment.querySelector(".thread-body");
  const firstMessage = fragment.querySelector(".first-message");
  const firstMessageImages = fragment.querySelector(".first-message-images");
  const threadAvatar = fragment.querySelector(".thread-avatar");
  const threadAuthorName = fragment.querySelector(".thread-author-name");
  const updated = fragment.querySelector(".thread-updated");
  const total = fragment.querySelector(".message-total");
  const messages = fragment.querySelector(".messages");
  const replyForm = fragment.querySelector(".reply-form");
  const replyInput = fragment.querySelector(".reply-input");
  const deleteThreadButton = fragment.querySelector(".delete-thread");
  const expanded = state.expandedThreadIds.has(thread.id);

  root.dataset.threadId = thread.id;
  root.classList.toggle("expanded", expanded);
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  threadAuthorName.textContent = state.profile.name;
  renderAvatar(threadAvatar, state.profile);
  firstMessage.textContent = thread.messages[0].text || (thread.messages[0].images.length ? "Image note" : "Untitled thread");
  renderFirstMessageImages(firstMessageImages, thread.messages[0]);
  updated.dateTime = thread.updatedAt;
  updated.textContent = formatDate(thread.updatedAt);
  total.textContent = `${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`;

  thread.messages.forEach((message, index) => {
    messages.append(renderMessage(thread, message, index === 0));
  });

  toggle.addEventListener("click", () => {
    if (state.expandedThreadIds.has(thread.id)) {
      state.expandedThreadIds.delete(thread.id);
    } else {
      state.expandedThreadIds.add(thread.id);
    }
    render();
  });

  deleteThreadButton.addEventListener("click", () => {
    if (!confirm("Delete this thread file?")) {
      return;
    }
    deleteThread(thread).catch((error) => {
      state.error = "The thread file could not be deleted.";
      console.error(error);
      render();
    });
  });

  const replyFiles = [];
  const composer = fragment.querySelector(".composer");
  const replyImageInput = fragment.querySelector(".reply-image-input");
  const pendingImages = fragment.querySelector(".pending-images");

  replyImageInput.addEventListener("change", () => {
    appendImageFiles(replyImageInput.files, replyFiles, pendingImages);
    replyImageInput.value = "";
  });
  bindImagePaste(composer, replyFiles, pendingImages);

  bindAutoGrow(replyInput);
  replyInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.shiftKey) {
      return;
    }
    event.preventDefault();
    replyForm.requestSubmit();
  });

  replyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = replyInput.value.trim();
    if (!text && replyFiles.length === 0) {
      replyInput.focus();
      return;
    }
    try {
      const images = await uploadImages(replyFiles);
      thread.messages.push(createMessage(text, images));
      thread.updatedAt = new Date().toISOString();
      replyInput.value = "";
      replyFiles.splice(0, replyFiles.length);
      scheduleThreadSave(thread);
      render();
    } catch (error) {
      state.error = "One or more images could not be uploaded.";
      console.error(error);
      render();
    }
  });

  return fragment;
}

function renderMessage(thread, message, isFirstMessage = false) {
  const fragment = document.querySelector("#messageTemplate").content.cloneNode(true);
  const root = fragment.querySelector(".message");
  const author = fragment.querySelector(".message-author");
  const avatar = fragment.querySelector(".message-avatar");
  const authorName = fragment.querySelector(".message-author-name");
  const text = fragment.querySelector(".message-text");
  const input = fragment.querySelector(".message-input");
  const images = fragment.querySelector(".message-images");
  const editImageRow = fragment.querySelector(".edit-image-row");
  const editImageInput = fragment.querySelector(".edit-image-input");
  const editPendingImages = fragment.querySelector(".edit-pending-images");
  const time = fragment.querySelector("time");
  const editButton = fragment.querySelector(".edit-message");
  const saveButton = fragment.querySelector(".save-message");
  const cancelButton = fragment.querySelector(".cancel-edit-message");
  const deleteButton = fragment.querySelector(".delete-message");

  const editFiles = [];
  bindImagePaste(root, editFiles, editPendingImages);

  if (isFirstMessage) {
    root.classList.add("first-thread-message");
    author.hidden = false;
    authorName.textContent = state.profile.name;
    renderAvatar(avatar, state.profile);
  }

  text.textContent = message.text;
  input.value = message.text;
  time.dateTime = message.updatedAt;
  time.textContent = formatDate(message.updatedAt);
  renderMessageImages(images, message);
  bindAutoGrow(input);

  editImageInput.addEventListener("change", () => {
    appendImageFiles(editImageInput.files, editFiles, editPendingImages);
    editImageInput.value = "";
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      saveButton.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelButton.click();
    }
  });

  editButton.addEventListener("click", () => {
    root.classList.add("editing");
    text.hidden = true;
    input.hidden = false;
    editImageRow.hidden = false;
    editButton.hidden = true;
    saveButton.hidden = false;
    cancelButton.hidden = false;
    input.value = message.text;
    autoGrow(input);
    input.focus();
  });

  saveButton.addEventListener("click", async () => {
    const nextText = input.value.trim();
    if (!nextText && message.images.length === 0 && editFiles.length === 0) {
      input.focus();
      return;
    }

    try {
      const newImages = await uploadImages(editFiles);
      message.text = nextText;
      message.images = [...message.images, ...newImages];
      message.updatedAt = new Date().toISOString();
      thread.updatedAt = message.updatedAt;
      scheduleThreadSave(thread);
      render();
    } catch (error) {
      state.error = "One or more images could not be uploaded.";
      console.error(error);
      render();
    }
  });

  cancelButton.addEventListener("click", () => {
    input.value = message.text;
    editFiles.splice(0, editFiles.length);
    editPendingImages.replaceChildren();
    root.classList.remove("editing");
    text.hidden = false;
    input.hidden = true;
    editImageRow.hidden = true;
    editButton.hidden = false;
    saveButton.hidden = true;
    cancelButton.hidden = true;
  });

  deleteButton.addEventListener("click", () => {
    if (thread.messages.length === 1) {
      if (!confirm("Deleting the only message will remove the thread file.")) {
        return;
      }
      deleteThread(thread).catch((error) => {
        state.error = "The thread file could not be deleted.";
        console.error(error);
        render();
      });
      return;
    }

    thread.messages = thread.messages.filter((item) => item.id !== message.id);
    thread.updatedAt = new Date().toISOString();
    scheduleThreadSave(thread);
    render();
  });

  return fragment;
}

function renderThreadHeader(thread) {
  const root = elements.threadList.querySelector(`[data-thread-id="${thread.id}"]`);
  if (!root) {
    return;
  }
  root.querySelector(".first-message").textContent =
    thread.messages[0].text || (thread.messages[0].images.length ? "Image note" : "Untitled thread");
  renderFirstMessageImages(root.querySelector(".first-message-images"), thread.messages[0]);
}

function openNewThreadDialog() {
  elements.threadTextInput.value = "";
  newThreadFiles.splice(0, newThreadFiles.length);
  renderPendingImages(elements.threadPendingImages, newThreadFiles, () => {});
  elements.threadDialog.showModal();
  autoGrow(elements.threadTextInput);
  elements.threadTextInput.focus();
}

function bindEvents() {
  const saveProfileName = () => {
    const name = elements.profileNameInput.value.trim();
    elements.profileTitle.hidden = false;
    elements.profileNameInput.hidden = true;
    if (!name || name === state.profile.name) {
      elements.profileNameInput.value = state.profile.name;
      return;
    }
    saveProfile({ ...state.profile, name });
  };

  elements.profileTitle.addEventListener("click", () => {
    elements.profileNameInput.value = state.profile.name;
    elements.profileTitle.hidden = true;
    elements.profileNameInput.hidden = false;
    elements.profileNameInput.focus();
    elements.profileNameInput.select();
  });
  elements.profileNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveProfileName();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      elements.profileNameInput.value = state.profile.name;
      elements.profileTitle.hidden = false;
      elements.profileNameInput.hidden = true;
    }
  });
  elements.profileNameInput.addEventListener("blur", saveProfileName);
  elements.profileImageInput.addEventListener("change", async () => {
    const file = elements.profileImageInput.files?.[0];
    elements.profileImageInput.value = "";
    if (!file || !file.type.startsWith("image/")) {
      return;
    }
    try {
      const image = await uploadImage(file);
      await saveProfile({ ...state.profile, imageUrl: image.url });
    } catch (error) {
      state.error = "The profile thumbnail could not be saved.";
      console.error(error);
      render();
    }
  });
  elements.newThreadButton.addEventListener("click", openNewThreadDialog);
  elements.emptyNewThreadButton.addEventListener("click", openNewThreadDialog);
  elements.reloadButton.addEventListener("click", loadThreads);
  elements.searchInput.addEventListener("input", render);
  elements.threadImageInput.addEventListener("change", () => {
    appendImageFiles(elements.threadImageInput.files, newThreadFiles, elements.threadPendingImages);
    elements.threadImageInput.value = "";
  });
  bindImagePaste(elements.threadDialog, newThreadFiles, elements.threadPendingImages);
  elements.threadTextInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.shiftKey) {
      return;
    }
    event.preventDefault();
    elements.createThreadButton.click();
  });
  document.addEventListener("paste", (event) => {
    if (event.defaultPrevented || !state.activePasteTarget) {
      return;
    }
    handleImagePaste(event, state.activePasteTarget.files, state.activePasteTarget.container);
  });
  bindAutoGrow(elements.threadTextInput);
  elements.expandAllButton.addEventListener("click", () => {
    state.threads.forEach((thread) => state.expandedThreadIds.add(thread.id));
    render();
  });
  elements.collapseAllButton.addEventListener("click", () => {
    state.expandedThreadIds.clear();
    render();
  });
  elements.createThreadButton.addEventListener("click", (event) => {
    event.preventDefault();
    const text = elements.threadTextInput.value.trim();
    if (!text && newThreadFiles.length === 0) {
      elements.threadTextInput.focus();
      return;
    }
    createThread(text, newThreadFiles)
      .then(() => {
        newThreadFiles.splice(0, newThreadFiles.length);
        elements.threadDialog.close();
      })
      .catch((error) => {
        state.error =
          error.status === 501
            ? "Thread creation needs the file-backed server. Stop python3 -m http.server and run python3 server.py."
            : "The thread file could not be created.";
        console.error(error);
        render();
      });
  });
  document.querySelector("#cancelThreadButton").addEventListener("click", () => {
    elements.threadDialog.close();
  });
}

bindEvents();
loadProfile();
loadThreads();
