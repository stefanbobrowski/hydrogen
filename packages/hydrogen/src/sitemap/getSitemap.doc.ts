import {ReferenceEntityTemplateSchema} from '@shopify/generate-docs';

const data: ReferenceEntityTemplateSchema = {
  name: 'getSitemap',
  category: 'utilities',
  isVisualComponent: false,
  related: [
    {
      name: 'getSitemapIndex',
      type: 'utilities',
      url: '/api/hydrogen/utilities/getSitemapIndex',
    },
  ],
  description: `> Caution:\n> This component is in an unstable pre-release state and may have breaking changes in a future release.\n\nGenerate a sitemap for a specific resource type. Returns a standard Response object.`,
  type: 'utility',
  defaultExample: {
    description: 'I am the default example',
    codeblock: {
      tabs: [
        {
          title: 'JavaScript',
          code: './getSitemap.example.jsx',
          language: 'js',
        },
        {
          title: 'TypeScript',
          code: './getSitemap.example.tsx',
          language: 'ts',
        },
      ],
      title: 'Example code',
    },
  },
  definitions: [
    {
      title: 'getSitemap',
      type: 'GetSitemapGeneratedType',
      description: '',
    },
  ],
};

export default data;