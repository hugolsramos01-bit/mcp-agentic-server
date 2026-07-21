export const Products = {
  slug: 'products',
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'details',
      type: 'group',
      fields: [
        { name: 'sku', type: 'text', unique: true },
        { name: 'weight', type: 'number' },
      ],
    },
    {
      name: 'variants',
      type: 'array',
      fields: [
        { name: 'color', type: 'text' },
        { name: 'stock', type: 'number' },
      ],
    },
    {
      name: 'content',
      type: 'blocks',
      blocks: [
        { slug: 'text-block', fields: [{ name: 'body', type: 'richText' }] },
        { slug: 'image-block', fields: [{ name: 'image', type: 'upload', relationTo: 'media' }] },
      ],
    },
    {
      name: 'tabs',
      type: 'tabs',
      tabs: [
        { name: 'seo', fields: [{ name: 'metaTitle', type: 'text' }, { name: 'metaDescription', type: 'textarea' }] },
        { name: 'inventory', fields: [{ name: 'inStock', type: 'checkbox' }] },
      ],
    },
  ],
  access: { read: () => true },
  hooks: { beforeChange: [] },
};
