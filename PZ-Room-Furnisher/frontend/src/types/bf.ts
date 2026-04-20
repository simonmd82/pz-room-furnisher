export interface BfGroupSummary {
  index:      number;
  label:      string;
  pieceCount: number;
  entryCount: number;
}

export interface BfGroupDetail {
  label:  string;
  pieces: BfPieceDto[];
}

export interface BfPieceDto {
  layer?:   string;
  entries:  BfEntryDto[];
}

export interface BfEntryDto {
  orient:     string;
  rootTileId: string;
  tileLayout: string[][];
}

