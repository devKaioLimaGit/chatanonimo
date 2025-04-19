const { PrismaClient } = require("../generated/prisma");

const prismaClient = new PrismaClient();

module.exports = prismaClient;