package com.example.voxel.model;

/**
 * A placed block: position + material + color + placer info (SPEC v2).
 *
 * <p>{@code by} is the placer's nickname snapshot (taken at confirm time;
 * pending blocks carry the owner's current nickname). {@code placedAt} is
 * the confirm-time epoch millis, null while pending. {@code pending} marks
 * unconfirmed blocks of the current turn; {@code byId} is the owner's
 * clientId while pending (kept after confirm for reference).
 */
public record Block(int x, int y, int z, String material, String color,
                    String by, Long placedAt, boolean pending, String byId) {

    public Coord coord() {
        return new Coord(x, y, z);
    }
}
