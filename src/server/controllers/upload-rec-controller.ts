import { parseRecordedGameMetadata } from "../recParser/recParser";
import { RecordedGameMetadata } from "@/types/recParser/RecordedGameParser";
import getMongoClient from "@/db/mongo/mongo-client";
import RecordedGameModel from "@/db/mongo/model/RecordedGameModel";
import { uploadRecToS3 } from "../services/aws";
import { BuildModel } from "@/db/mongo/model/BuildNumber";

export type UploadRecParams = {
  file: File;
  userId: string;
  gameTitle: string;
};

export function mapRecGameMetadata(data: RecordedGameMetadata) {
  const mappedData = data;
  mappedData.playerData = mappedData.playerData.filter(
    (_player, idx) => idx !== 0
  );
  delete mappedData.commands;
  delete mappedData.commandParserWarnings;
  mappedData.playerData.forEach((playerData) => delete playerData.techTimes);
  return mappedData;
}

export default async function uploadRec(
  params: UploadRecParams
): Promise<void> {
  const { file, userId, gameTitle } = params;

  // 1) parse file
  const recGameMetadata: RecordedGameMetadata = await parseRecordedGameMetadata(
    file
  );
  const mappedRecGameMetadata = mapRecGameMetadata(recGameMetadata); //cleanup the data

  // 2) save build number to mongo, if build number doesn't already exists
  await getMongoClient();
  try {
    // Check if a record with the given buildNumber already exists
    const existingBuild = await BuildModel.findOne({
      where: { buildNumber: recGameMetadata.buildNumber },
    });

    // If no record exists, create a new one
    if (!existingBuild) {
      await BuildModel.create({
        buildNumber: recGameMetadata.buildNumber,
        releaseDate: Date.now(),
      });
    }
  } catch (error) {
    console.error("Error inserting build number:", error);
  }

  // 2) save file to mongo, if game guid doesn't already exists
  await getMongoClient();
  try {
    await RecordedGameModel.create({
      ...mappedRecGameMetadata,
      uploadedByUserId: userId,
      gameTitle,
    });
  } catch (error: any) {
    if (error.code === 11000) {
      console.warn("Rec already uploaded to Mongo");
      throw new Error("UNIQUE_KEY_VIOLATION"); // game already uploaded
    }
    // TODO - this will throw on unique constraint violation, but should probably be handled more gracefully
    console.error("Error saving to mongo: ", error);
    throw new Error("Error saving to mongo");
  }

  // 3) upload to S3
  try {
    await uploadRecToS3({
      file: file,
      metadata: {
        ...recGameMetadata,
      },
      userId,
    });
  } catch (error) {
    console.error("Error uploading to s3: ", error);
    // delete from mongo if s3 upload fails
    RecordedGameModel.deleteOne({ gameGuid: recGameMetadata.gameGuid });
    throw new Error("Error uploading to s3");
  }
}
