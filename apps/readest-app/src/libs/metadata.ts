import { MetadataResult, SearchRequest } from '@/services/metadata/types';
import { MetadataService } from '@/services/metadata/service';

export const searchMetadata = async (request: SearchRequest): Promise<MetadataResult[]> => {
  // The personal/Tauri build uses Open Library directly. It is anonymous and
  // avoids the Readest account-gated metadata proxy (and its server API keys).
  return await new MetadataService().search(request);
};
