import { getUnhandledDeclaredHomeyApiRoutes } from './helpers/homeyApiMock';

describe('homeyApiMock', () => {
  it('provides a mock handler for every route declared in app.json', () => {
    expect(getUnhandledDeclaredHomeyApiRoutes()).toEqual([]);
  });
});
