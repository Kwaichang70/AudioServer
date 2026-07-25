import { describe, expectTypeOf, it } from 'vitest';
import { api } from '../client.js';
import type {
  ApiResponse,
  FavoriteStation,
  HealthResponse,
  ProviderSearchResponse,
  QobuzStreamInfo,
  SpotifyConnectDevice,
} from '../types.js';

describe('API response contracts', () => {
  it('exposes concrete provider and health response types', () => {
    expectTypeOf(api.getHealth).returns.toEqualTypeOf<Promise<HealthResponse>>();
    expectTypeOf(api.providerSearch).returns.toEqualTypeOf<Promise<ProviderSearchResponse>>();
    expectTypeOf(api.getQobuzStreamUrl).returns.toEqualTypeOf<
      Promise<ApiResponse<QobuzStreamInfo>>
    >();
    expectTypeOf(api.spotifyConnectDevices).returns.toEqualTypeOf<
      Promise<ApiResponse<SpotifyConnectDevice[]>>
    >();
  });

  it('narrows favorites from the requested item type', () => {
    expectTypeOf(api.getFavorites<'station'>).returns.toEqualTypeOf<
      Promise<ApiResponse<FavoriteStation[]>>
    >();
    const invalidTrackFavoritesRequest = () => {
      // `/history/favorites?type=track` is not enriched; callers must use
      // getFavoriteTracks() instead.
      // @ts-expect-error track is intentionally excluded from getFavorites
      return api.getFavorites('track');
    };
    expectTypeOf(invalidTrackFavoritesRequest).toBeFunction();
  });
});
