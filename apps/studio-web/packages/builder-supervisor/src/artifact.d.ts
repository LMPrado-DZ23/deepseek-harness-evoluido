export interface VerifiedBuildArtifact {
    readonly archivePath: string;
    readonly archiveBytes: number;
    readonly wireSha256: string;
    readonly sha256: string;
    readonly files: number;
    readonly bytes: number;
    dispose(): Promise<void>;
}
export declare function createVerifiedBuildArchive(artifactRoot: string, relativePath: string, expectedSha256?: string, signal?: AbortSignal): Promise<VerifiedBuildArtifact>;
//# sourceMappingURL=artifact.d.ts.map