// Validation script for rooms feature
import { RoomsAPI } from './src/features/rooms';

// Test that the API compiles and types are correct
async function validateRoomsFeature() {
  try {
    console.log('Validating Rooms Feature...');
    
    const api = new RoomsAPI('./test-data');
    
    // Test room management types
    const createResult = await api.createRoom('test-room', 'Test description');
    console.log('Create room result type:', typeof createResult);
    
    const listResult = await api.listRooms();
    console.log('List rooms result type:', typeof listResult);
    
    // Test presence management types  
    const enterResult = await api.enterRoom('test-agent', 'test-room', {
      role: 'tester',
      description: 'Test agent',
      capabilities: ['testing'],
      metadata: { test: true }
    });
    console.log('Enter room result type:', typeof enterResult);
    
    const usersResult = await api.getRoomUsers('test-room');
    console.log('Room users result type:', typeof usersResult);
    
    console.log('✅ Rooms feature validation completed successfully');
    
  } catch (error) {
    console.error('❌ Validation failed:', error);
    process.exit(1);
  }
}

validateRoomsFeature();