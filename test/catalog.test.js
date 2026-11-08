import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { Category } from "../src/models/category.js";
import { MenuItem } from "../src/models/menu-item.js";

const categoryId = "000000000000000000000001";

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role ? { user: { id: "staff", role } } : null;
      },
    },
  };
}

function createCatalog() {
  const categories = new Map();
  const items = new Map();
  let nextId = 2;

  function makeQuery(getResult) {
    let offset = 0;
    let pageLimit = Infinity;
    return {
      sort() { return this; },
      skip(value) { offset = value; return this; },
      limit(value) { pageLimit = value; return this; },
      async lean() {
        const result = await getResult();
        return Array.isArray(result)
          ? result.slice(offset, offset + pageLimit).map((record) => ({ ...record }))
          : result && { ...result };
      },
    };
  }

  const CategoryModel = {
    countDocuments: async () => categories.size,
    find: () => makeQuery(async () => [...categories.values()].sort((a, b) => a.name.localeCompare(b.name))),
    async create(fields) {
      const record = { ...fields, _id: String(nextId++).padStart(24, "0") };
      categories.set(record._id, record);
      return { ...record };
    },
    async findByIdAndUpdate(id, update) {
      const record = categories.get(id);
      if (!record) return null;
      Object.assign(record, update.$set);
      return { ...record };
    },
    findById: (id) => makeQuery(async () => categories.get(id) ?? null),
    async deleteOne({ _id }) { categories.delete(_id); },
    async exists({ _id }) {
      return categories.has(_id) ? { _id } : null;
    },
  };
  const MenuItemModel = {
    async exists(filter) {
      return [...items.values()].some((item) => String(item.categoryId) === String(filter.categoryId))
        ? { _id: true }
        : null;
    },
    countDocuments: async (filter) => filterItems(items, filter).length,
    find: (filter) => makeQuery(async () => filterItems(items, filter)),
    async create(fields) {
      const record = { ...fields, _id: String(nextId++).padStart(24, "0") };
      items.set(record._id, record);
      return { ...record };
    },
    async findByIdAndUpdate(id, update) {
      const record = items.get(id);
      if (!record) return null;
      Object.assign(record, update.$set);
      return { ...record };
    },
  };
  return { Category: CategoryModel, MenuItem: MenuItemModel, categories, items };
}

function filterItems(items, filter) {
  return [...items.values()]
    .filter((item) => item.isAvailable === filter.isAvailable)
    .filter((item) => !filter.categoryId || String(item.categoryId) === String(filter.categoryId))
    .filter((item) => !filter.name || new RegExp(filter.name.$regex, filter.name.$options).test(item.name));
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("category and menu item schemas use indexed fields and integer minor-unit prices", async () => {
  const category = new Category({ name: "Bowls" });
  await category.validate();
  assert.equal(Category.schema.options.timestamps, true);
  assert.ok(Category.schema.indexes().some(([keys, options]) => keys.name === 1 && options.unique));

  const valid = new MenuItem({
    name: "Rice bowl",
    categoryId,
    priceMinor: 125,
  });
  await valid.validate();
  assert.equal(valid.isAvailable, true);
  assert.equal(valid.imageUrl, "");
  assert.equal(MenuItem.schema.options.timestamps, true);
  assert.ok(MenuItem.schema.indexes().some(([keys]) => keys.categoryId === 1));

  const zeroPrice = new MenuItem({
    name: "Free item",
    categoryId,
    priceMinor: 0,
  });
  await assert.rejects(zeroPrice.validate());
  assert.ok(MenuItem.schema.path("imageUrl"));
});

test("catalog APIs require staff writes and preserve referenced categories", async () => {
  const catalog = createCatalog();
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...catalog,
  });
  await withServer(app, async (baseUrl) => {
    const categoryPost = (role, body) => fetch(`${baseUrl}/api/v1/categories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": role },
      body: JSON.stringify(body),
    });

    assert.equal((await categoryPost("waiter", { name: "Bowls" })).status, 403);
    const createdCategory = await categoryPost("manager", { name: "Bowls" });
    assert.equal(createdCategory.status, 201);
    const category = (await createdCategory.json()).data.category;

    const forbiddenItem = await fetch(`${baseUrl}/api/v1/menu-items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "customer" },
      body: JSON.stringify({
        name: "Rice bowl",
        categoryId: category._id,
        priceMinor: 125,
      }),
    });
    assert.equal(forbiddenItem.status, 403);

    const createdItem = await fetch(`${baseUrl}/api/v1/menu-items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({
        name: "Rice bowl",
        categoryId: category._id,
        priceMinor: 125,
        isAvailable: false,
      }),
    });
    assert.equal(createdItem.status, 400);

    const itemResponse = await fetch(`${baseUrl}/api/v1/menu-items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({
        name: "Rice bowl",
        categoryId: category._id,
        priceMinor: 125,
        imageUrl: "https://example.com/not-hosted-by-imgbb.jpg",
      }),
    });
    assert.equal(itemResponse.status, 400);

    const validItemResponse = await fetch(`${baseUrl}/api/v1/menu-items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({
        name: "Rice bowl",
        categoryId: category._id,
        priceMinor: 125,
      }),
    });
    assert.equal(validItemResponse.status, 201);
    const item = (await validItemResponse.json()).data.menuItem;

    const availableMenu = await fetch(`${baseUrl}/api/v1/menu-items`, {
      headers: { "x-test-role": "customer" },
    });
    assert.equal((await availableMenu.json()).meta.total, 1);

    const blockedDelete = await fetch(`${baseUrl}/api/v1/categories/${category._id}`, {
      method: "DELETE",
      headers: { "x-test-role": "manager" },
    });
    assert.equal(blockedDelete.status, 409);

    const archived = await fetch(`${baseUrl}/api/v1/menu-items/${item._id}`, {
      method: "DELETE",
      headers: { "x-test-role": "manager" },
    });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).data.menuItem.isAvailable, false);

    const emptyMenu = await fetch(`${baseUrl}/api/v1/menu-items`, {
      headers: { "x-test-role": "customer" },
    });
    assert.equal((await emptyMenu.json()).meta.total, 0);

    assert.equal(catalog.items.size, 1);
    assert.equal(catalog.categories.has(category._id), true);
  });
});

test("menu item image uploads require manager or admin and save verified ImgBB URLs", async () => {
  const catalog = createCatalog();
  let externalUploads = 0;
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...catalog,
    imgbbApiKey: "test-imgbb-key",
    imageUploadFetch: async (url, options) => {
      externalUploads += 1;
      assert.equal(url.hostname, "api.imgbb.com");
      assert.equal(url.searchParams.get("key"), "test-imgbb-key");
      const uploadedImage = Buffer.from(options.body.get("image"), "base64");
      if (options.body.get("name") === "dish.jpg") {
        assert.deepEqual(uploadedImage.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
      } else {
        assert.match(options.body.get("image"), /^[A-Za-z0-9+/]+=*$/);
      }
      return Response.json({
        success: true,
        data: { url: "https://i.ibb.co/example/menu-item.png" },
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    async function upload(
      role,
      {
        bytes = [137, 80, 78, 71, 13, 10, 26, 10],
        type = "image/png",
        filename = "menu.png",
      } = {},
    ) {
      const form = new FormData();
      form.append(
        "image",
        new Blob([Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes], { type }),
        filename,
      );
      return fetch(`${baseUrl}/api/v1/menu-items/images`, {
        method: "POST",
        headers: { "x-test-role": role },
        body: form,
      });
    }

    assert.equal((await upload("waiter")).status, 403);
    assert.equal(externalUploads, 0);

    const uploaded = await upload("manager");
    assert.equal(uploaded.status, 201);
    const imageUrl = (await uploaded.json()).data.imageUrl;
    assert.equal(imageUrl, "https://i.ibb.co/example/menu-item.png");
    assert.equal(externalUploads, 1);

    const avifBytes = await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
    )).avif().toBuffer();
    const avifUpload = await upload("manager", {
      bytes: avifBytes,
      type: "image/avif",
      filename: "dish.avif",
    });
    assert.equal(avifUpload.status, 201, await avifUpload.clone().text());
    assert.equal(externalUploads, 2);

    const category = await catalog.Category.create({ name: "Bowls" });
    const created = await fetch(`${baseUrl}/api/v1/menu-items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "manager" },
      body: JSON.stringify({
        name: "Rice bowl",
        description: "Grilled vegetables and rice",
        categoryId: category._id,
        priceMinor: 1250,
        imageUrl,
      }),
    });
    assert.equal(created.status, 201);
    const createdItem = (await created.json()).data.menuItem;
    assert.equal(createdItem.imageUrl, imageUrl);

    const updated = await fetch(`${baseUrl}/api/v1/menu-items/${createdItem._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-role": "manager" },
      body: JSON.stringify({
        name: "Rice bowl",
        description: "Updated details",
        categoryId: category._id,
        priceMinor: 1250,
        isAvailable: true,
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.menuItem.imageUrl, imageUrl);

    const invalidImage = await upload("admin", { bytes: [1, 2, 3, 4] });
    assert.equal(invalidImage.status, 400);
    assert.equal(externalUploads, 2);

    const oversizedImage = await upload("manager", {
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    });
    assert.equal(oversizedImage.status, 413);
    assert.equal(externalUploads, 2);
  });
});

test("menu item image upload reports missing ImgBB configuration", async () => {
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...createCatalog(),
  });
  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("image", new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
      type: "image/png",
    }), "menu.png");
    const response = await fetch(`${baseUrl}/api/v1/menu-items/images`, {
      method: "POST",
      headers: { "x-test-role": "admin" },
      body: form,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "IMAGE_UPLOAD_NOT_CONFIGURED");
  });
});
