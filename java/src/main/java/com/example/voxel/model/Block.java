package com.example.voxel.model;

/** A placed block: position + material + color (all stored server-side). */
public record Block(int x, int y, int z, String material, String color) {

    public Coord coord() {
        return new Coord(x, y, z);
    }
}
